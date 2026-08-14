#!/usr/bin/env bash
set -euo pipefail

# Bash-unit test rollback/verify logiky z scripts/deploy-verify.sh (issue 425).
# CI nevie skutočný produkčný deploy odbehnúť — tento test mockuje `docker` a
# `curl` cez PATH stuby a overí vetvy: šťastná cesta, pomalý štart s retry,
# rollback sa zotaví, žiaden predošlý image, rollback tiež zlyhá.
# Spustenie: bash scripts/deploy-verify.test.sh  (alebo `pnpm test:deploy-script`)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/deploy-verify.sh"
[ -f "$SCRIPT" ] || { echo "nenašiel som $SCRIPT" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
LOG="$WORK/docker.log"
SEQ="$WORK/curl.seq"

# --- docker stub: zaloguje každé volanie (vrátane IMAGE_TAG env), vráti
#     mocknuté ps/inspect výstupy, ostatné (pull/up) uspejú.
cat > "$BIN/docker" <<'STUB'
#!/usr/bin/env bash
echo "IMAGE_TAG=${IMAGE_TAG:-} ARGS=$*" >> "$MOCK_DOCKER_LOG"
mode=
for a in "$@"; do
  case "$a" in
    inspect) mode=inspect ;;
    ps) mode=ps ;;
  esac
done
case "$mode" in
  inspect) printf '%s\n' "${MOCK_PREV_IMAGE:-}" ;;
  ps) printf '%s\n' "${MOCK_PREV_CONTAINER:-}" ;;
  *) exit "${MOCK_DOCKER_EXIT:-0}" ;;
esac
STUB
chmod +x "$BIN/docker"

# --- curl stub: skriptovaná postupnosť odpovedí (MOCK_CURL_SEQ, token na
#     riadok). Token "FAIL" = HTTP chyba (exit 22, ako curl -f na 5xx), inak
#     vráti {"version":"<token>",...}. Po vyčerpaní opakuje posledný riadok.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
seqfile="$MOCK_CURL_SEQ"
cnt="${seqfile}.n"
i=0; [ -f "$cnt" ] && i=$(cat "$cnt")
i=$((i + 1)); printf '%s' "$i" > "$cnt"
line=$(sed -n "${i}p" "$seqfile")
[ -n "$line" ] || line=$(tail -n1 "$seqfile")
if [ "$line" = "FAIL" ]; then exit 22; fi
printf '{"version":"%s","commit":"test"}\n' "$line"
STUB
chmod +x "$BIN/curl"

# --- výsledky
FAILS=0
CASE=""
ok()   { echo "  ✓ [$CASE] $1"; }
fail() { echo "  ✗ [$CASE] $1"; FAILS=$((FAILS + 1)); }

# --- spustenie skriptu s mocknutým prostredím. Args = postupnosť curl odpovedí.
OUT=""; RC=0
run() {
  rm -f "$SEQ" "$SEQ.n"; : > "$LOG"
  printf '%s\n' "$@" > "$SEQ"
  set +e
  OUT=$(PATH="$BIN:$PATH" \
    MOCK_DOCKER_LOG="$LOG" MOCK_CURL_SEQ="$SEQ" \
    MOCK_PREV_CONTAINER="${PREV_CONTAINER-}" MOCK_PREV_IMAGE="${PREV_IMAGE-}" \
    COMPOSE_FILE="docker-compose.prod.yml" APP_SERVICE="app" \
    LIVE_HOSTNAME="example.test" IMAGE_TAG="${NEW-}" \
    VERIFY_RETRIES="${RETRIES-3}" VERIFY_INTERVAL="0" \
    bash "$SCRIPT" 2>&1)
  RC=$?
  set -e
}

assert_rc()        { if [ "$RC" = "$1" ]; then ok "exit $RC"; else fail "exit: čakal $1, dostal $RC"; fi; }
assert_out_has()   { if printf '%s' "$OUT" | grep -qF -- "$1"; then ok "výstup obsahuje: $1"; else fail "výstup NEobsahuje: $1"; fi; }
assert_out_hasnt() { if printf '%s' "$OUT" | grep -qF -- "$1"; then fail "výstup NEMÁ obsahovať: $1"; else ok "výstup neobsahuje: $1"; fi; }
assert_log_has()   { if grep -qF -- "$1" "$LOG"; then ok "docker volanie: $1"; else fail "docker NEvolal: $1"; fi; }
assert_log_hasnt() { if grep -qF -- "$1" "$LOG"; then fail "docker NEMAL volať: $1"; else ok "docker nevolal: $1"; fi; }

ROLLBACK_CALL="IMAGE_TAG=0.3.0-dev.254 ARGS=compose -f docker-compose.prod.yml up -d app"

# ---------------------------------------------------------------------------
CASE="1. šťastná cesta (overí sa hneď, žiaden rollback)"
PREV_CONTAINER="cid-prev"; PREV_IMAGE="ghcr.io/zbynekdrlik/forestshop-app:0.3.0-dev.254"
NEW="0.3.0-dev.255"; RETRIES=3
run "0.3.0-dev.255"
assert_rc 0
assert_out_has "nasadenie OK — produkcia beží na 0.3.0-dev.255"
assert_log_hasnt "up -d app"

# ---------------------------------------------------------------------------
CASE="2. pomalý štart — retry (2× 502, potom OK; žiaden rollback)"
run FAIL FAIL "0.3.0-dev.255"
assert_rc 0
assert_out_has "pokus 3/3"
assert_out_has "nasadenie OK — produkcia beží na 0.3.0-dev.255"
assert_log_hasnt "up -d app"

# ---------------------------------------------------------------------------
CASE="3. zlá verzia → rollback sa zotaví (job ostane červený)"
run FAIL FAIL FAIL "0.3.0-dev.254"
assert_rc 1
assert_out_has "spúšťam automatický rollback"
assert_out_has "rollback OK — produkcia beží na 0.3.0-dev.254 (nová verzia 0.3.0-dev.255 NEPREŠLA)"
assert_log_has "$ROLLBACK_CALL"

# ---------------------------------------------------------------------------
CASE="4. žiaden predošlý image — nie je na čo rollbacknúť"
PREV_CONTAINER=""; PREV_IMAGE=""
run FAIL FAIL FAIL
assert_rc 1
assert_out_has "žiaden predošlý image na rollback"
assert_log_hasnt "up -d app"

# ---------------------------------------------------------------------------
CASE="5. rollback tiež zlyhá — kritická chyba (job červený)"
PREV_CONTAINER="cid-prev"; PREV_IMAGE="ghcr.io/zbynekdrlik/forestshop-app:0.3.0-dev.254"
run FAIL FAIL FAIL FAIL FAIL FAIL
assert_rc 1
assert_out_has "rollback zlyhal — predošlá verzia 0.3.0-dev.254 sa neohlásila"
assert_log_has "$ROLLBACK_CALL"

# ---------------------------------------------------------------------------
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "VŠETKY testy prešli."
else
  echo "ZLYHANÍ: $FAILS"
  exit 1
fi
