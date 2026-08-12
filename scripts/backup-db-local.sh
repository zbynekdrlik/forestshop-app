#!/usr/bin/env bash
set -euo pipefail

# Nočná záloha na forestshop-dev (178.105.89.168) — LOKÁLNA varianta
# scripts/backup-db.sh z repozitára zbynekdrlik/forestshop-app.
#
# Prečo existuje samostatne: pôvodný scripts/backup-db.sh (dev2) po dumpe a
# šifrovaní .env sám AKTÍVNE PUSHUJE oba súbory na dev1 cez
# BACKUP_HOST=newlevel@100.104.8.125 (Tailscale IP). Táto škatuľka
# (forestshop-dev) nemá do dev1 žiadnu sieťovú cestu — nemá nainštalovaný
# tailscale klient a dev1 nemá verejnú adresu — takže ten istý push by tu
# vždy zlyhal (timeout) a skript by skončil na `exit 1` PRED tým, než by
# vôbec zašifroval .env alebo zmazal staré zálohy podľa retencie.
#
# Riešenie: smer sa obrátil. Táto škatuľka robí LEN lokálnu časť (dump,
# over pg_restore --list, zašifruj .env, zmaž staršie ako 14 dní) a súbory
# si odtiaľto STIAHNE dev1 vlastným pull cronom
# (~/backups/pull-forestshop-dev-backup.sh, beží 02:25 — 10 min po tomto
# skripte). Heslo v /srv/forestshop/.backup-passphrase sem bolo nakopírované
# RUČNE, jednorazovo, z existujúcej kópie na dev1 (rovnaké heslo ako pri
# dev2 — SHA-256 overené) — tento skript ho preto len POUŽÍVA, nikdy
# negeneruje ani nepushuje (na rozdiel od dev2 varianty).

STAMP=$(date +%Y%m%dT%H%M%S)
DIR=/srv/forestshop/backups
COMPOSE="docker compose -f /srv/forestshop/docker-compose.prod.yml"
mkdir -p "$DIR"

ENV_SRC=/srv/forestshop/.env
PASS_FILE=/srv/forestshop/.backup-passphrase

if [ -f "$ENV_SRC" ]; then
  command -v gpg > /dev/null 2>&1 || {
    echo "chyba: 'gpg' nie je nainštalované — zálohovanie $ENV_SRC by zlyhalo" >&2
    exit 1
  }
  [ -s "$PASS_FILE" ] || {
    echo "chyba: $PASS_FILE chýba alebo je prázdny — bez neho sa .env nedá zašifrovať (a dev1 pull by ho nemal ako rozšifrovať)" >&2
    exit 1
  }
fi

DUMP="$DIR/forestshop-$STAMP.dump"
$COMPOSE exec -T postgres pg_dump -U forestshop -Fc forestshop > "$DUMP"

# Over, že dump je čitateľný PRED zašifrovaním .env aj pred mazaním starých
# záloh — poškodený/prázdny dump zastaví skript hneď, nikdy sa neoznačí za
# platnú zálohu ani kvôli nemu nezmažú ešte platné staršie zálohy.
if ! $COMPOSE exec -T postgres pg_restore --list < "$DUMP" > /dev/null; then
  echo "záloha zlyhala — dump $DUMP nie je čitateľný pg_restore --list" >&2
  exit 1
fi

if [ -f "$ENV_SRC" ]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS_FILE" \
    --output "$DIR/forestshop-$STAMP.env.gpg" "$ENV_SRC"
else
  echo "upozornenie: $ENV_SRC neexistuje, zálohuje sa iba databáza" >&2
fi

find "$DIR" -name 'forestshop-*.dump' -mtime +14 -delete
find "$DIR" -name 'forestshop-*.env.gpg' -mtime +14 -delete
echo "záloha hotová: forestshop-$STAMP.dump"
