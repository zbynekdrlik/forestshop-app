#!/usr/bin/env bash
set -euo pipefail

# Bash-unit test alertovacieho routingu z scripts/uptime-check.sh (issue 499).
# Doktrína analyze-not-ping (airuleset #704/#705): keyless `notify --body` je
# flood primitív; každý telefónny alert musí niesť stabilný per-incident
# `--dedup-key`, a periodické/stavové hlásenia idú do machine channelu
# (journal), nie na telefón. Tento test mockuje `curl`/`python3`/`date` cez
# PATH stuby a overí, že:
#   - potvrdený výpadok pošle PRÁVE JEDEN keyed telefónny down alert / incident,
#   - „stále down" NEvolá notify (ide do journalu),
#   - zotavenie pošle JEDEN keyed up alert s ROVNAKÝM incident id,
#   - nový výpadok po zotavení dostane NOVÝ incident id,
#   - --dry-run nikdy nevolá notify,
#   - KAŽDÉ notify volanie nesie --dedup-key (žiadny keyless send).
# Spustenie: bash scripts/uptime-check.test.sh  (alebo `pnpm test:uptime-script`)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/uptime-check.sh"
[ -f "$SCRIPT" ] || { echo "nenašiel som $SCRIPT" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
STATE="$WORK/state"
NOTIFYLOG="$WORK/notify.log"
OKLOG="$WORK/notify-ok.log"
CNTFILE="$WORK/notify.cnt"

# --- curl stub: vráti MOCK_HTTP_CODE ako `-w '%{http_code}'`. "FAIL" =
#     curl-level chyba (DNS/timeout/refused) → prázdny výstup, exit 22
#     (script's `|| true` → code="" → down=1). Inak vytlačí kód, exit 0.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
if [ "${MOCK_HTTP_CODE:-}" = "FAIL" ]; then exit 22; fi
printf '%s' "${MOCK_HTTP_CODE:-000}"
STUB
chmod +x "$BIN/curl"

# --- python3 stub: zachytí notify argv (každý POKUS) do MOCK_NOTIFY_LOG.
#     Injektovateľné zlyhanie: prvých MOCK_NOTIFY_FAIL_N volaní skončí exitom 1
#     (nedoručené); ostatné exit 0 a zapíšu DELIVERED do MOCK_NOTIFY_OK_LOG
#     (počet skutočných DORUČENÍ). Modeluje airuleset transient POST failure.
cat > "$BIN/python3" <<'STUB'
#!/usr/bin/env bash
echo "NOTIFY_ARGS: $*" >> "$MOCK_NOTIFY_LOG"
if [ "${MOCK_NOTIFY_FAIL_N:-0}" -gt 0 ]; then
  n=0; [ -f "$MOCK_NOTIFY_CNT" ] && n="$(cat "$MOCK_NOTIFY_CNT")"
  n=$((n + 1)); printf '%s' "$n" > "$MOCK_NOTIFY_CNT"
  if [ "$n" -le "$MOCK_NOTIFY_FAIL_N" ]; then exit 1; fi
fi
echo "DELIVERED: $*" >> "$MOCK_NOTIFY_OK_LOG"
exit 0
STUB
chmod +x "$BIN/python3"

# --- date stub: `+%s` vráti MOCK_NOW (riadené incident id); inak reálny date
#     (log timestamp `+%Y-...`). PATH má $BIN prvý, preto reálny date cez
#     absolútnu cestu (inak rekurzia).
cat > "$BIN/date" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    +%s) printf '%s\n' "${MOCK_NOW:-1000}"; exit 0 ;;
  esac
done
if [ -x /usr/bin/date ]; then exec /usr/bin/date "$@"; else exec /bin/date "$@"; fi
STUB
chmod +x "$BIN/date"

# --- výsledky
FAILS=0
CASE=""
ok()   { echo "  ✓ [$CASE] $1"; }
fail() { echo "  ✗ [$CASE] $1"; FAILS=$((FAILS + 1)); }

OUT=""; NOW=1000; FAIL_N=0
newscenario() { rm -f "$STATE" "$STATE".* "$CNTFILE" 2>/dev/null || true; : > "$NOTIFYLOG"; : > "$OKLOG"; FAIL_N=0; }

# pass HTTP_CODE [extra-script-args...]  — jeden beh skriptu (jeden „tick")
pass() {
  local http="$1"; shift
  set +e
  OUT=$(PATH="$BIN:$PATH" \
    MOCK_HTTP_CODE="$http" MOCK_NOW="$NOW" MOCK_NOTIFY_LOG="$NOTIFYLOG" \
    MOCK_NOTIFY_OK_LOG="$OKLOG" MOCK_NOTIFY_CNT="$CNTFILE" MOCK_NOTIFY_FAIL_N="$FAIL_N" \
    UPTIME_CHECK_URLS="https://test.example" \
    UPTIME_CHECK_STATE_FILE="$STATE" \
    AIRULESET_NOTIFY="/fake/airuleset.py" \
    bash "$SCRIPT" "$@" 2>&1)
  set -e
}

# grep -c vytlačí "0" a zároveň skončí exitom 1 pri nula zhodách — preto NIE
# `|| echo 0` (zdvojilo by 0 na "0\n0"), ale zachytenie + `|| n=0` (rovnaká
# hodnota, jeden riadok).
notify_count()    { local n; n="$(grep -c '^NOTIFY_ARGS:' "$NOTIFYLOG" 2>/dev/null)" || n=0; printf '%s' "$n"; }
delivered_count() { local n; n="$(grep -c '^DELIVERED:'  "$OKLOG"     2>/dev/null)" || n=0; printf '%s' "$n"; }
last_notify()     { grep '^NOTIFY_ARGS:' "$NOTIFYLOG" 2>/dev/null | tail -n1; }

assert_notify_count()    { local n; n="$(notify_count)"; if [ "$n" = "$1" ]; then ok "notify volaní = $1"; else fail "notify volaní: čakal $1, dostal $n"; fi; }
assert_delivered_count() { local n; n="$(delivered_count)"; if [ "$n" = "$1" ]; then ok "doručených alertov = $1"; else fail "doručených alertov: čakal $1, dostal $n"; fi; }
assert_last_has()      { if printf '%s' "$(last_notify)" | grep -qF -- "$1"; then ok "posledný notify obsahuje: $1"; else fail "posledný notify NEobsahuje: $1 (bol: $(last_notify))"; fi; }
assert_last_hasnt()    { if printf '%s' "$(last_notify)" | grep -qF -- "$1"; then fail "posledný notify NEMAL obsahovať: $1"; else ok "posledný notify neobsahuje: $1"; fi; }
assert_out_has()       { if printf '%s' "$OUT" | grep -qF -- "$1"; then ok "výstup obsahuje: $1"; else fail "výstup NEobsahuje: $1"; fi; }
# každý notify riadok musí niesť --dedup-key (žiadny keyless send)
assert_all_keyed() {
  local total keyed
  total="$(notify_count)"
  keyed="$(grep -c -- '--dedup-key' "$NOTIFYLOG" 2>/dev/null)" || keyed=0
  if [ "$total" = "$keyed" ]; then ok "všetkých $total notify volaní je keyed (0 keyless)"; else fail "keyless notify volania: $total celkom, $keyed keyed"; fi
}

# ---------------------------------------------------------------------------
CASE="1. zdravé (200) — žiaden alert"
newscenario
pass 200
assert_notify_count 0
assert_out_has "down=0"

# ---------------------------------------------------------------------------
CASE="2. jeden blik (1× FAIL) — pod prahom, žiaden alert"
newscenario
pass FAIL
assert_notify_count 0
assert_out_has "not yet confirmed"

# ---------------------------------------------------------------------------
CASE="3. potvrdený výpadok (2× FAIL) — JEDEN keyed down alert"
newscenario
NOW=1000
pass FAIL
pass FAIL
assert_notify_count 1
assert_last_has "--dedup-key"
assert_last_has "forestshop-uptime:down:"
assert_last_has ":1000"
assert_last_has "NEODPOVEDÁ"
assert_last_has "--owner-name marek"
assert_all_keyed

# ---------------------------------------------------------------------------
CASE="4. stále down (ďalšie FAIL) — machine channel, ŽIADEN nový notify"
# pokračuje zo stavu scenára 3 (rovnaký state súbor)
pass FAIL
assert_notify_count 1
assert_out_has "MACHINE-CHANNEL"
pass FAIL
assert_notify_count 1

# ---------------------------------------------------------------------------
CASE="5. zotavenie (200) — JEDEN keyed up alert, rovnaký incident id"
pass 200
assert_notify_count 2
assert_last_has "forestshop-uptime:up:"
assert_last_has ":1000"
assert_last_has "opäť dostupná"
assert_all_keyed

# ---------------------------------------------------------------------------
CASE="6. nový výpadok po zotavení — NOVÝ incident id"
NOW=2000
pass FAIL
pass FAIL
assert_notify_count 3
assert_last_has "forestshop-uptime:down:"
assert_last_has ":2000"
assert_last_hasnt ":1000"
assert_all_keyed

# ---------------------------------------------------------------------------
CASE="7. --dry-run — nikdy nevolá notify"
newscenario
NOW=1000
pass FAIL --dry-run
pass FAIL --dry-run
assert_notify_count 0
assert_out_has "WOULD phone-alert"
assert_out_has "dedup-key"

# ---------------------------------------------------------------------------
CASE="8. down alert NEDORUČENÝ na 1. pokus — zopakuje sa (nový kľúč) a doručí PRÁVE RAZ"
newscenario
FAIL_N=1              # airuleset notify zlyhá pri PRVOM volaní, potom uspeje
NOW=3000
pass FAIL             # confirm=1 (pod prahom)
pass FAIL             # confirm=2 -> Lane 1 pokus#1 -> notify ZLYHÁ, _alerted ostáva 0
assert_out_has "NEDORUČENÝ"
assert_delivered_count 0
assert_last_has ":3000"
NOW=3300             # čas postúpi -> ďalší pokus dostane NOVÝ incident-id (nový kľúč)
pass FAIL             # confirm=3 -> Lane 1 pokus#2 -> notify USPEJE, _alerted=1
assert_delivered_count 1
assert_last_has "forestshop-uptime:down:"
assert_last_has ":3300"
NOW=3600
pass FAIL             # confirm=4 -> Lane 2 (journal), žiaden ďalší pokus
assert_delivered_count 1
assert_out_has "MACHINE-CHANNEL"

# ---------------------------------------------------------------------------
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "VŠETKY testy prešli."
else
  echo "ZLYHANÍ: $FAILS"
  exit 1
fi
