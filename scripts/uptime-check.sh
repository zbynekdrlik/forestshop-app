#!/usr/bin/env bash
# airuleset:script-ok watchdog must survive every per-pass failure and keep polling on the
# next timer tick — same convention as camera-box/scripts/imag-obs-alert-watchdog.sh
# (set -uo pipefail, not -e: a single curl failure must not kill the whole pass).
#
# scripts/uptime-check.sh — issue 357, external public-URL availability monitor.
#
# HELP-BEGIN
# WHY: nič doteraz z VONKU nekontrolovalo, či `forestshop.newlevel.media` /
# `forestshop-novy.newlevel.media` žijú — 12. 8. 2026 objavil výpadok (Cloudflare
# Error 1033, pozri .claude/rules/deploy.md) majiteľ, nie automatika. Beží NA
# DEV1, zámerne NIE na dev2 (kde bežia appka aj tunel) — monitor na tom istom
# stroji, čo sleduje, by zomrel presne v momente výpadku, ktorý má hlásiť.
# Rovnaká "measure -> decide -> alert" topológia ako
# camera-box/scripts/imag-obs-alert-watchdog.sh a `api-watchdog.timer` (systemd
# --user timer na dev1 s hotovým Discord kanálom).
#
# Perióda (systemd timer) 5 min. Potvrdenie po 2 zlyhaniach OKAMIHU za sebou
# (~10 min súvislého výpadku) — jeden jednorazový blik (krátky sieťový hik) sa
# nealertuje. Alert pre TÚ ISTÚ prebiehajúcu udalosť sa neopakuje častejšie než
# raz za ALERT_THROTTLE_PASSES prechodov (predvolene 12 = ~1h pri 5min cadence)
# — žiadny spam pre jeden trvajúci výpadok. Pri zotavení (URL, čo bolo predtým
# potvrdene dole, teraz vráti 200) sa pošle JEDNA správa o zotavení a stav sa
# vyčistí.
#
# Usage:
#   scripts/uptime-check.sh            # one pass: measure -> decide -> alert
#   scripts/uptime-check.sh --dry-run  # measure + decide + LOG only; never alert
#   scripts/uptime-check.sh --help
# HELP-END
set -uo pipefail

# Prints everything between the HELP-BEGIN/HELP-END marker comments above,
# stripped of the leading "# " — a marker range instead of hard-coded line
# numbers, so editing the header comment can never silently desync --help
# from its actual content (review finding, issue 357).
print_help() {
  awk '
    /^# HELP-BEGIN/ { on=1; next }
    /^# HELP-END/   { on=0 }
    on              { sub(/^# ?/, ""); print }
  ' "${BASH_SOURCE[0]}"
}

case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  --help|-h)
    print_help
    exit 0
    ;;
  "") DRY_RUN=0 ;;
  *) echo "uptime-check: unknown arg '$1' (try --help)" >&2; exit 2 ;;
esac

# ── config (all env-overridable) ─────────────────────────────────────────────
# Bez trailing lomky — curl aj štítky nižšie sa opierajú o presne tento tvar.
# Pole, nie reťazec + `for url in $URLS` — review finding, issue 357: neúvodzovkovaná
# expanzia reťazca sa spolieha na delenie slov (funguje, ale je krehké); pole je
# odolnejšie a jasnejšie vyjadruje zámer (viacero nezávislých URL).
read -ra URLS <<< "${UPTIME_CHECK_URLS:-https://forestshop.newlevel.media https://forestshop-novy.newlevel.media}"
CONFIRM_THRESHOLD="${UPTIME_CHECK_CONFIRM_THRESHOLD:-2}"
ALERT_THROTTLE_PASSES="${UPTIME_CHECK_ALERT_THROTTLE_PASSES:-12}"   # ~1h at the 5-min cadence
CURL_TIMEOUT="${UPTIME_CHECK_CURL_TIMEOUT:-10}"

NOTIFY="${AIRULESET_NOTIFY:-$HOME/devel/airuleset/airuleset.py}"
OWNER_NAME="${UPTIME_CHECK_OWNER:-marek}"
REPO_SLUG="${UPTIME_CHECK_REPO:-zbynekdrlik/forestshop-app}"

STATE_DIR="${UPTIME_CHECK_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}}"
STATE_FILE="${UPTIME_CHECK_STATE_FILE:-$STATE_DIR/forestshop-app-uptime-check.state}"

log() { printf '%s [uptime-check] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; }

# ── measure: HTTP status code for one URL (empty on curl-level failure, e.g.
# DNS/timeout/refused — that IS a down signal here, unlike a remote SSH probe
# whose failure could mean "can't reach the probe box", not "target is down":
# a curl failure against a PUBLIC internet URL from dev1 has no such ambiguity) ─
probe_one() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$1" 2>/dev/null || true
}

# ── read / write persisted per-URL state ────────────────────────────────────
# Key namespaced by a sanitized URL so both endpoints get independent
# confirm/throttle tracking (one down, one up must not mask each other).
sanitize_key() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'; }

read_state_field() {
  local key="$1" default="$2"
  [ -f "$STATE_FILE" ] || { printf '%s' "$default"; return 0; }
  local v
  v="$(sed -n "s/^${key}=//p" "$STATE_FILE" 2>/dev/null | tail -1)"
  printf '%s' "${v:-$default}"
}
write_state_field() {
  local key="$1" val="$2" tmp
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  tmp="$(mktemp "${STATE_FILE}.XXXXXX" 2>/dev/null || echo "$STATE_FILE")"
  { [ -f "$STATE_FILE" ] && grep -v "^${key}=" "$STATE_FILE"; printf '%s=%s\n' "$key" "$val"; } \
    > "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$STATE_FILE" 2>/dev/null || true
}

send_alert() {
  local body="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] WOULD alert: $body"
    return 0
  fi
  log "ALERT: firing Discord notification"
  python3 "$NOTIFY" notify --body "$body" --owner-name "$OWNER_NAME" \
    >/dev/null 2>&1 || log "ALERT: airuleset.py notify failed (non-fatal)"
}

# ── one URL: measure -> confirm -> throttle -> alert/recover ───────────────
check_url() {
  local url="$1" key code down prev_confirm confirm
  key="$(sanitize_key "$url")"

  code="$(probe_one "$url")"
  down=0
  [ "$code" = "200" ] || down=1
  log "url=$url code='${code:-<none>}' down=$down"

  prev_confirm="$(read_state_field "${key}_confirm" 0)"
  if [ "$down" -eq 1 ]; then
    confirm=$((prev_confirm + 1))
  else
    confirm=0
  fi
  write_state_field "${key}_confirm" "$confirm"
  log "url=$url confirm=$prev_confirm -> $confirm (threshold=$CONFIRM_THRESHOLD)"

  # Recovered (was previously CONFIRMED down, now healthy) -> one recovery
  # message, then clear the alert dedup so a FUTURE fresh outage always alerts.
  local was_alerted
  was_alerted="$(read_state_field "${key}_alerted" 0)"
  if [ "$down" -eq 0 ]; then
    if [ "$was_alerted" = "1" ]; then
      send_alert "✅ uptime-check ($REPO_SLUG): $url je opäť dostupná (HTTP $code)."
    fi
    write_state_field "${key}_alerted" 0
    write_state_field "${key}_throttle_passes" 0
    return 0
  fi

  if [ "$confirm" -lt "$CONFIRM_THRESHOLD" ]; then
    log "url=$url not yet confirmed down (below threshold) — no alert this pass"
    return 0
  fi

  # Confirmed down. Throttle repeat alerts for the SAME ongoing outage.
  local prior_passes
  if [ "$was_alerted" = "1" ]; then
    prior_passes="$(read_state_field "${key}_throttle_passes" 0)"
    prior_passes=$((prior_passes + 1))
    if [ "$prior_passes" -lt "$ALERT_THROTTLE_PASSES" ]; then
      write_state_field "${key}_throttle_passes" "$prior_passes"
      log "url=$url already alerted, suppressed by throttle (pass ${prior_passes}/${ALERT_THROTTLE_PASSES})"
      return 0
    fi
    log "url=$url still down after throttle window — re-alerting"
  fi

  write_state_field "${key}_alerted" 1
  write_state_field "${key}_throttle_passes" 0
  send_alert "🚨 uptime-check ($REPO_SLUG): $url NEODPOVEDÁ (HTTP ${code:-<žiadna odpoveď>}) už ${CONFIRM_THRESHOLD}+ prechodov za sebou."
}

main() {
  log "pass start (dry_run=$DRY_RUN, threshold=$CONFIRM_THRESHOLD, throttle=$ALERT_THROTTLE_PASSES)"
  for url in "${URLS[@]}"; do
    check_url "$url"
  done
  log "pass end"
}

# Run only when EXECUTED (systemd/CLI). Sourcing (tests) only defines the functions above.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
