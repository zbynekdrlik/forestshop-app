#!/usr/bin/env bash
# airuleset:script-ok watchdog must survive every per-pass failure and keep polling on the
# next timer tick — same convention as camera-box/scripts/imag-obs-alert-watchdog.sh
# (set -uo pipefail, not -e: a single curl failure must not kill the whole pass).
#
# scripts/uptime-check.sh — issue 357, external public-URL availability monitor.
#
# HELP-BEGIN
# WHY: nič doteraz z VONKU nekontrolovalo, či `forestshop.newlevel.media` žije
# — 12. 8. 2026 objavil výpadok (Cloudflare
# Error 1033, pozri .claude/rules/deploy.md) majiteľ, nie automatika. Beží NA
# DEV1, zámerne NIE na dev2 (kde bežia appka aj tunel) — monitor na tom istom
# stroji, čo sleduje, by zomrel presne v momente výpadku, ktorý má hlásiť.
# Rovnaká "measure -> decide -> alert" topológia ako
# camera-box/scripts/imag-obs-alert-watchdog.sh a `api-watchdog.timer` (systemd
# --user timer na dev1 s hotovým Discord kanálom).
#
# Perióda (systemd timer) 5 min. Potvrdenie po 2 zlyhaniach OKAMIHU za sebou
# (~10 min súvislého výpadku) — jeden jednorazový blik (krátky sieťový hik) sa
# nealertuje.
#
# Routing alertov (issue 499, doktrína analyze-not-ping — airuleset #704/#705):
# telefón (Discord) dostane LEN genuine nový actionable prechod stavu, a to
# vždy s per-incident `--dedup-key`, takže ten istý incident nikdy nepinguje
# znova:
#   * prvé potvrdenie výpadku -> JEDEN keyed ping (kľúč `<prefix>:down:<url>:<id>`),
#   * zotavenie predtým potvrdeného výpadku -> JEDEN keyed ping (`…:up:…:<id>`),
#     s ROVNAKÝM incident-id ako down alert, ktorý uzatvára.
# Prebiehajúci (už oznámený) výpadok sa na KAŽDOM ďalšom prechode zapíše LEN do
# journalu (machine channel), NIKDY znova na telefón — žiadny spam pre jeden
# trvajúci výpadok. `<id>` = epoch prvého potvrdenia; nový skutočný výpadok
# dostane nový id -> nový kľúč -> alert. Keyless `notify --body` (bez
# `--dedup-key`) je flood primitív a je tu ZAKÁZANÝ.
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
# issue 488: `forestshop-novy.newlevel.media` sa vypína (majiteľ, appka beží len
# na hlavnej doméne), takže default kontroluje UŽ LEN hlavnú adresu; env override
# `UPTIME_CHECK_URLS` ostáva, keby bolo treba sledovať aj ďalšie adresy.
read -ra URLS <<< "${UPTIME_CHECK_URLS:-https://forestshop.newlevel.media}"
CONFIRM_THRESHOLD="${UPTIME_CHECK_CONFIRM_THRESHOLD:-2}"
CURL_TIMEOUT="${UPTIME_CHECK_CURL_TIMEOUT:-10}"

NOTIFY="${AIRULESET_NOTIFY:-$HOME/devel/airuleset/airuleset.py}"
OWNER_NAME="${UPTIME_CHECK_OWNER:-marek}"
REPO_SLUG="${UPTIME_CHECK_REPO:-zbynekdrlik/forestshop-app}"

# issue 499 (airuleset #704/#705, doktrína analyze-not-ping): každý telefónny
# alert nesie stabilný per-incident `--dedup-key` `<prefix>:<down|up>:<url-key>:
# <incident-id>`, aby ten istý prebiehajúci incident NEpingoval znova (airuleset
# `notify` zdedupe podľa kľúča). Keyless send (bez `--dedup-key`) je flood
# primitív a je tu ZAKÁZANÝ.
DEDUP_PREFIX="${UPTIME_CHECK_DEDUP_PREFIX:-forestshop-uptime}"

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
# confirm / alerted / incident tracking (one down, one up must not mask each
# other).
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

# PHONE (Discord) — ONLY a genuine NEW actionable state TRANSITION (outage
# start / recovery). ALWAYS carries a stable per-incident `--dedup-key` so the
# SAME incident never re-pings (airuleset dedups on the key). A repeated status
# for an UNCHANGED state must NEVER come here — route it through log_machine().
send_phone_alert() {
  local dedup_key="$1" body="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] WOULD phone-alert (dedup-key=$dedup_key): $body"
    return 0
  fi
  log "ALERT: firing Discord notification (dedup-key=$dedup_key)"
  python3 "$NOTIFY" notify --body "$body" --owner-name "$OWNER_NAME" \
    --dedup-key "$dedup_key" \
    >/dev/null 2>&1 || log "ALERT: airuleset.py notify failed (non-fatal)"
}

# MACHINE CHANNEL — a periodic / repeated STATE report goes to the journal
# (stderr -> systemd journal), NEVER the phone (doktrína analyze-not-ping,
# airuleset #704/#705). No `notify` call is made here.
log_machine() {
  log "MACHINE-CHANNEL: $*"
}

# ── one URL: measure -> confirm -> route (phone transition / journal state) ──
# Three routing lanes (issue 499, doktrína analyze-not-ping):
#   1. NEW confirmed outage      -> ONE keyed PHONE alert  (down:<incident-id>)
#   2. ongoing known outage      -> journal (machine channel) only, NEVER phone
#   3. recovery of a known outage-> ONE keyed PHONE alert  (up:<same incident-id>)
# The incident-id (epoch of the first confirmation) makes each real outage's
# dedup key unique, so a genuinely new outage always alerts while the same
# ongoing incident never re-pings.
check_url() {
  local url="$1" key code down prev_confirm confirm was_alerted incident_id
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

  was_alerted="$(read_state_field "${key}_alerted" 0)"

  # Lane 3 — recovered (was CONFIRMED down, now healthy): ONE keyed recovery
  # phone ping for THIS incident, then clear incident state so a FUTURE fresh
  # outage always alerts with a new incident-id.
  if [ "$down" -eq 0 ]; then
    if [ "$was_alerted" = "1" ]; then
      incident_id="$(read_state_field "${key}_incident" 0)"
      send_phone_alert "${DEDUP_PREFIX}:up:${key}:${incident_id}" \
        "✅ uptime-check ($REPO_SLUG): $url je opäť dostupná (HTTP $code)."
    fi
    write_state_field "${key}_alerted" 0
    write_state_field "${key}_incident" 0
    write_state_field "${key}_incident_passes" 0
    return 0
  fi

  if [ "$confirm" -lt "$CONFIRM_THRESHOLD" ]; then
    log "url=$url not yet confirmed down (below threshold) — no alert this pass"
    return 0
  fi

  # Lane 2 — already alerted for this ongoing incident: a periodic STATE report,
  # NOT a phone ping. Route to the machine channel (journal) only.
  if [ "$was_alerted" = "1" ]; then
    local passes
    passes="$(read_state_field "${key}_incident_passes" 0)"
    passes=$((passes + 1))
    write_state_field "${key}_incident_passes" "$passes"
    incident_id="$(read_state_field "${key}_incident" 0)"
    log_machine "url=$url STÁLE NEDOSTUPNÁ (HTTP ${code:-<žiadna odpoveď>}) — incident=$incident_id, prechod ${passes} — telefón sa NEpinguje (periodický stavový report)"
    return 0
  fi

  # Lane 1 — first confirmation of a NEW outage: the ONE genuine new actionable
  # event. Capture a fresh incident-id and send exactly ONE keyed phone alert.
  incident_id="$(date +%s)"
  write_state_field "${key}_alerted" 1
  write_state_field "${key}_incident" "$incident_id"
  write_state_field "${key}_incident_passes" 0
  send_phone_alert "${DEDUP_PREFIX}:down:${key}:${incident_id}" \
    "🚨 uptime-check ($REPO_SLUG): $url NEODPOVEDÁ (HTTP ${code:-<žiadna odpoveď>}) už ${CONFIRM_THRESHOLD}+ prechodov za sebou."
}

main() {
  log "pass start (dry_run=$DRY_RUN, threshold=$CONFIRM_THRESHOLD, dedup_prefix=$DEDUP_PREFIX)"
  for url in "${URLS[@]}"; do
    check_url "$url"
  done
  log "pass end"
}

# Run only when EXECUTED (systemd/CLI). Sourcing (tests) only defines the functions above.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
