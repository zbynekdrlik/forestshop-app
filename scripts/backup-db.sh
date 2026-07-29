#!/usr/bin/env bash
set -euo pipefail

# Nočná záloha: databázový dump + zašifrovaná kópia /srv/forestshop/.env
# (POSTGRES_PASSWORD, CF_TUNNEL_TOKEN) — tie existujú LEN na dev2, teda práve na
# tom stroji, ktorého stratu má táto záloha prežiť. Bez nich by obnovený dump
# nebol na nič: nová inštancia by sa nevedela pripojiť k Postgresu ani spustiť
# tunel.
#
# Šifrovanie .env: uprednostní sa `age` s kľúčmi príjemcov
# (/srv/forestshop/.backup-age-recipients, jeden verejný age kľúč na riadok) —
# ale LEN keď je nastavený, lebo `age`-ovo heslové (symetrické, -p) šifrovanie
# vždy číta heslo z terminálu a nedá sa preto bezpečne spustiť z cronu/CI.
# Bez tohto nastavenia (dnešný stav dev2 — age tam vôbec nie je) sa použije
# `gpg --symmetric` s heslom z /srv/forestshop/.backup-passphrase (mode 600),
# ktorý si skript pri prvom behu sám založí — heslo sa nikde nehardcoduje ani
# nevypisuje.
#
# OBNOVA (v núdzi, na inom stroji než dev2):
#   1. stiahni súbory:  scp dev1:~/backups/forestshop/forestshop-<STAMP>.* .
#   2. rozšifruj .env:
#        - cez age:  age -d -i <tvoj-súkromný-age-kľúč> forestshop-<STAMP>.env.age > .env
#        - cez gpg:  gpg --batch --passphrase-file .backup-passphrase \
#                       --decrypt forestshop-<STAMP>.env.gpg > .env
#                    (heslo je na dev2 v /srv/forestshop/.backup-passphrase, ak ten
#                    stroj ešte žije; inak treba heslo z bezpečného úložiska, kam
#                    si ho operátor uložil pri prvom behu tohto skriptu)
#   3. over dump:       spusti dočasný Postgres kontajner (rovnaký obraz ako
#                       v docker-compose.prod.yml) a v ňom:
#                       docker exec -i <kontajner> pg_restore --list < forestshop-<STAMP>.dump
#                       (nesmie zlyhať — presne to robí táto záloha už PRI ZÁLOHOVANÍ,
#                       viď nižšie, aj scripts/restore-drill.sh pri cvičnej obnove)
#   4. obnov dáta:      scripts/restore-drill.sh forestshop-<STAMP>.dump (cvičná/dočasná
#                       obnova), alebo pg_restore priamo do nového produkčného Postgresu
#   5. nasaď rozšifrovaný .env na nové /srv/forestshop/.env (mode 600) a spusti
#                       docker compose -f docker-compose.prod.yml up -d

STAMP=$(date +%Y%m%dT%H%M%S)
DIR=/srv/forestshop/backups
COMPOSE="docker compose -f /srv/forestshop/docker-compose.prod.yml"
mkdir -p "$DIR"

DUMP="$DIR/forestshop-$STAMP.dump"
$COMPOSE exec -T postgres pg_dump -U forestshop -Fc forestshop > "$DUMP"

# Over, že dump je vôbec čitateľný, PRED kopírovaním aj pred mazaním starých
# záloh — prázdny/poškodený dump sa už raz stal, a bez tejto kontroly by ho
# nikto nezistil, kým by nebolo neskoro (staré zálohy by sa medzitým zmazali).
# Hostiteľ nemá pg_restore nainštalovaný — beží v postgres kontajneri, tak ako
# vyššie pg_dump.
if ! $COMPOSE exec -T postgres pg_restore --list < "$DUMP" > /dev/null; then
  echo "záloha zlyhala — dump $DUMP nie je čitateľný pg_restore --list" >&2
  exit 1
fi

# Zašifrovaná kópia .env vedľa dumpu — pozri komentár na začiatku súboru.
ENV_SRC=/srv/forestshop/.env
AGE_RECIPIENTS_FILE=/srv/forestshop/.backup-age-recipients
if [ -f "$ENV_SRC" ]; then
  if command -v age > /dev/null 2>&1 && [ -f "$AGE_RECIPIENTS_FILE" ]; then
    age -R "$AGE_RECIPIENTS_FILE" -o "$DIR/forestshop-$STAMP.env.age" "$ENV_SRC"
  else
    PASS_FILE=/srv/forestshop/.backup-passphrase
    if [ ! -f "$PASS_FILE" ]; then
      umask 077
      head -c 32 /dev/urandom | base64 > "$PASS_FILE"
      chmod 600 "$PASS_FILE"
    fi
    gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS_FILE" \
      --output "$DIR/forestshop-$STAMP.env.gpg" "$ENV_SRC"
  fi
else
  echo "upozornenie: $ENV_SRC neexistuje, zálohuje sa iba databáza" >&2
fi

# záloha je bezcenná, kým leží na tom istom stroji ako dáta
# (dev1 = 100.104.8.125 cez Tailscale — bare meno "dev1" sa na dev2 nedá vyriešiť,
# MagicDNS beží tenantovo, ale tailscale0 tu nemá nastavený žiadny DNS scope)
rsync -a "$DIR"/forestshop-"$STAMP".* newlevel@100.104.8.125:~/backups/forestshop/

find "$DIR" -name 'forestshop-*.dump' -mtime +14 -delete
find "$DIR" -name 'forestshop-*.env.age' -mtime +14 -delete
find "$DIR" -name 'forestshop-*.env.gpg' -mtime +14 -delete
echo "záloha hotová: forestshop-$STAMP.dump"
