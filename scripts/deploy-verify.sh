#!/usr/bin/env bash
set -euo pipefail

# Nasadenie appky s overením a AUTOMATICKÝM rollbackom (issue 425 — výpadok
# 13. 8. 2026). Vyčlenené z `.github/workflows/deploy.yml` do skriptu, aby sa
# rollback logika dala jednotkovo testovať (scripts/deploy-verify.test.sh) —
# CI nevie skutočný produkčný deploy odbehnúť, ale túto logiku áno, s
# mocknutými `docker`/`curl` cez PATH stuby.
#
# Tok:
#   1. Zapamätaj tag PRÁVE bežiaceho image (pred akoukoľvek zmenou).
#   2. Nasaď: `docker compose pull app` + `up -d`.
#   3. Over `/api/version` v ohraničenej retry slučke (nie jeden pokus po
#      sleep 5 — pomalý štart s migráciami nie je zlyhanie).
#   4. Pri zlyhaní overenia (alebo pádu nasadenia) vráť predošlý image
#      (`IMAGE_TAG=<predošlá> docker compose up -d app`) a over zotavenie.
#   5. Ak nová verzia neprešla, skonči NENULOVO — job ostane červený (signál,
#      že nová verzia nešla), ale produkcia beží ďalej na predošlej. Rollback
#      chybu NIKDY neskryje (no-continue-on-error).
#
# Konfigurácia cez env (rozumné defaulty):
#   IMAGE_TAG       (povinné) — nová verzia/tag na nasadenie (očakávaná verzia)
#   LIVE_HOSTNAME   (povinné) — hostname pre https://<host>/api/version
#   COMPOSE_FILE    (default docker-compose.prod.yml) — relatívny k cwd
#   APP_SERVICE     (default app) — názov compose služby appky
#   VERIFY_RETRIES  (default 12) — počet pokusov overenia
#   VERIFY_INTERVAL (default 5)  — sekundy medzi pokusmi
#   VERSION_PATH    (default /api/version)

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
APP_SERVICE="${APP_SERVICE:-app}"
VERIFY_RETRIES="${VERIFY_RETRIES:-12}"
VERIFY_INTERVAL="${VERIFY_INTERVAL:-5}"
VERSION_PATH="${VERSION_PATH:-/api/version}"
# Každý pokus musí byť OHRANIČENÝ v čase — cieľom tiketu je RÝCHLE, ohraničené
# zotavenie. Crashloopujúca appka odpovedá rýchlo (connection-refused / 502 z
# tunela), ale appka, ktorá VISÍ na požiadavke (napr. zaseknuté DB spojenie pri
# štarte), by bez tohto blokovala curl až do vzdialeného edge timeoutu pri
# KAŽDOM pokuse a odsúvala tak automatický rollback, ktorý má tento skript
# garantovať. `--max-time` drží každý pokus predvídateľne krátky.
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-10}"
: "${IMAGE_TAG:?chýba IMAGE_TAG (nová verzia na nasadenie)}"
: "${LIVE_HOSTNAME:?chýba LIVE_HOSTNAME}"

NEW_TAG="$IMAGE_TAG"

# Vytiahni "version" pole z JSON tela /api/version bez závislosti na node —
# telo je plochý objekt {"version":"...","commit":"..."}. Portable sed
# (rovnaký výsledok na runneri aj v teste s mocknutým curl).
extract_version() {
  printf '%s' "$1" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Over, že živá appka hlási očakávanú verziu — v retry slučke. Padnutý curl
# (HTTP chyba / nedostupné) sa CHYTÍ cez `if`, takže `set -e` skript nezhodí
# uprostred overovania (zámerné ošetrenie, nie bypass). Návrat 0 = OK, 1 = nie.
verify_version() {
  local want="$1" attempts="$2" interval="$3"
  local i body live
  for ((i = 1; i <= attempts; i++)); do
    if body=$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "https://${LIVE_HOSTNAME}${VERSION_PATH}" 2>/dev/null); then
      live=$(extract_version "$body")
      if [ "$live" = "$want" ]; then
        echo "overenie OK (pokus $i/$attempts): live=$live"
        return 0
      fi
      echo "pokus $i/$attempts: live=${live:-<prázdne>}, čakám na $want"
    else
      echo "pokus $i/$attempts: ${VERSION_PATH} neodpovedá (HTTP chyba / nedostupné)"
    fi
    if [ "$i" -lt "$attempts" ]; then sleep "$interval"; fi
  done
  return 1
}

# Tag práve bežiaceho image (PRED nasadením). Prázdny, ak žiaden kontajner
# nebeží (prvé nasadenie) — vtedy nie je na čo rollbacknúť.
capture_prev_tag() {
  local container image
  container=$(docker compose -f "$COMPOSE_FILE" ps -q "$APP_SERVICE" 2>/dev/null || true)
  [ -n "$container" ] || { echo ""; return 0; }
  image=$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)
  # ghcr.io/...:<tag> — po poslednej dvojbodke je tag (registre tu nemajú port,
  # tag verzie je tvaru X.Y.Z-dev.N bez dvojbodky), takže ##*: je jednoznačné.
  echo "${image##*:}"
}

# Nasaď novú verziu. `&&` reťaz: keď pull padne, up sa nespustí. Volané v `if`
# podmienke, takže návratový kód sa vyhodnotí bez zhodenia skriptu pod `set -e`.
deploy() {
  docker compose -f "$COMPOSE_FILE" pull "$APP_SERVICE" \
    && docker compose -f "$COMPOSE_FILE" up -d
}

# Vráť predošlý image a over zotavenie. Návrat 0 = produkcia sa zotavila,
# 1 = ani rollback sa nepodaril (treba ručný zásah).
rollback() {
  local prev_tag="$1"
  # Bezpečný rollback cieľ musí byť konkrétny PREDOŠLÝ verzný tag. Prázdny =
  # prvé nasadenie. `latest` (kontajner spustený mimo pipeline s nepinnutým
  # IMAGE_TAG) aj tag ZHODNÝ s novou verziou by rollback nasmerovali na ten
  # istý práve pokazený image (build job pushuje aj `:latest`) — v oboch
  # prípadoch nie je na čo bezpečne rollbacknúť.
  if [ -z "$prev_tag" ] || [ "$prev_tag" = "latest" ] || [ "$prev_tag" = "$NEW_TAG" ]; then
    echo "::error::žiaden bezpečný predošlý image na rollback (tag='${prev_tag:-<žiaden>}') — produkcia môže byť down, treba ručný zásah"
    return 1
  fi
  echo "vraciam predošlý image: $prev_tag"
  if ! IMAGE_TAG="$prev_tag" docker compose -f "$COMPOSE_FILE" up -d "$APP_SERVICE"; then
    echo "::error::rollback príkaz (up -d $APP_SERVICE) zlyhal — produkcia môže byť down, treba ručný zásah"
    return 1
  fi
  if verify_version "$prev_tag" "$VERIFY_RETRIES" "$VERIFY_INTERVAL"; then
    echo "rollback OK — produkcia beží na $prev_tag (nová verzia $NEW_TAG NEPREŠLA)"
    return 0
  fi
  echo "::error::rollback zlyhal — predošlá verzia $prev_tag sa neohlásila, produkcia môže byť down, treba ručný zásah"
  return 1
}

main() {
  local prev_tag
  prev_tag=$(capture_prev_tag)
  echo "predošlý bežiaci tag: ${prev_tag:-<žiaden>}; nasadzujem: $NEW_TAG"

  if deploy && verify_version "$NEW_TAG" "$VERIFY_RETRIES" "$VERIFY_INTERVAL"; then
    echo "nasadenie OK — produkcia beží na $NEW_TAG"
    return 0
  fi

  echo "::warning::nasadenie/overenie novej verzie $NEW_TAG zlyhalo — spúšťam automatický rollback"
  # Rollback obnoví produkciu, ale job MUSÍ ostať červený (nová verzia nešla) —
  # preto `main` vždy vráti 1 na tejto vetve, bez ohľadu na výsledok rollbacku.
  rollback "$prev_tag" || true
  return 1
}

main "$@"
