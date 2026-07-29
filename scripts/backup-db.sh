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
# vždy číta heslo z terminálu a nedá sa preto bezpečne spustiť z cronu/CI. V
# tomto režime drží súkromný age kľúč operátor MIMO dev2 (v recipients súbore
# je len jeho VEREJNÝ kľúč) — strata dev2 teda nikdy neohrozí dešifrovateľnosť.
#
# Bez tohto nastavenia (dnešný stav dev2 — age tam vôbec nie je) sa použije
# `gpg --symmetric` s heslom z /srv/forestshop/.backup-passphrase (mode 600),
# ktorý si skript pri prvom behu sám založí. Na rozdiel od age-recipients
# režimu je toto heslo JEDINÝ kľúč k .env — preto sa pri každom behu (nielen
# pri založení) overí a podľa potreby obnoví jeho kópia na dev1
# (~/backups/forestshop/.backup-passphrase, mode 600), presne tou istou cestou
# ako zašifrovaný .env a dump nižšie. Bez tejto kópie by strata dev2 (presne
# ten scenár, kvôli ktorému táto mimo-strojová záloha existuje) urobila
# .env.gpg natrvalo nerozšifrovateľným — heslo sa nikde nehardcoduje ani
# nevypisuje, len sa kopíruje ako súbor.
#
# OBNOVA na úplne novom stroji (dev2 je preč) — presný postup:
#   1. Zisti posledný STAMP (dev1 = newlevel@100.104.8.125 — POZOR, bare meno
#      "dev1" sa v tomto prostredí nedá spoľahlivo vyriešiť, presne z toho
#      istého dôvodu, prečo BACKUP_HOST nižšie používa Tailscale IP; použi ju
#      aj tu, nie bare meno):
#        ssh newlevel@100.104.8.125 'ls -1 ~/backups/forestshop/forestshop-*.dump | sort | tail -1'
#   2. Stiahni z dev1 VŠETKY tri súbory pre ten STAMP + heslo (heslo sa
#      nemení medzi behmi, stačí raz):
#        scp newlevel@100.104.8.125:~/backups/forestshop/forestshop-<STAMP>.dump .
#        scp newlevel@100.104.8.125:~/backups/forestshop/forestshop-<STAMP>.env.gpg .   # alebo .env.age, ak sa používa age
#        scp newlevel@100.104.8.125:~/backups/forestshop/.backup-passphrase .           # len pri gpg režime
#   3. Rozšifruj .env:
#        - cez gpg (predvolený režim, žiadny súkromný kľúč netreba):
#            gpg --batch --passphrase-file .backup-passphrase \
#                --decrypt forestshop-<STAMP>.env.gpg > .env
#        - cez age (ak bol nastavený AGE_RECIPIENTS_FILE): rozšifruje LEN
#          operátor svojím súkromným kľúčom, ktorý dev1/dev2 nikdy nemali:
#            age -d -i <operátorov súkromný age kľúč> forestshop-<STAMP>.env.age > .env
#   4. Over dump (nesmie zlyhať — presne toto robí táto záloha už PRI
#      ZÁLOHOVANÍ, pozri nižšie, aj scripts/restore-drill.sh pri cvičnej
#      obnove): spusti dočasný Postgres kontajner s rovnakým obrazom ako v
#      docker-compose.prod.yml a v ňom:
#            docker exec -i <kontajner> pg_restore --list < forestshop-<STAMP>.dump
#   5. Obnov dáta: scripts/restore-drill.sh forestshop-<STAMP>.dump (cvičná/
#      dočasná obnova do jednorazového kontajnera), alebo pg_restore priamo do
#      nového produkčného Postgresu.
#   6. Nasaď rozšifrovaný .env na nové /srv/forestshop/.env (mode 600, `chmod
#      600 /srv/forestshop/.env`) a spusti `docker compose -f
#      docker-compose.prod.yml up -d`.

STAMP=$(date +%Y%m%dT%H%M%S)
DIR=/srv/forestshop/backups
COMPOSE="docker compose -f /srv/forestshop/docker-compose.prod.yml"
mkdir -p "$DIR"

ENV_SRC=/srv/forestshop/.env
AGE_RECIPIENTS_FILE=/srv/forestshop/.backup-age-recipients
PASS_FILE=/srv/forestshop/.backup-passphrase
# Kam sa kopíruje zašifrovaný .env aj (pri gpg režime) heslo — ten istý cieľ
# ako dump nižšie. Bare meno "dev1" sa z dev2 nedá vyriešiť (MagicDNS beží
# tenantovo, tailscale0 tu nemá nastavený žiadny DNS scope), preto Tailscale IP.
BACKUP_HOST=newlevel@100.104.8.125
BACKUP_REMOTE_DIR=~/backups/forestshop

# Skontroluj HNEĎ na začiatku (pred drahým pg_dump), že nástroj na šifrovanie
# .env, ktorý sa naozaj použije, je nainštalovaný — nech skript zlyhá jasnou
# hláškou, nie záhadne uprostred behu.
if [ -f "$ENV_SRC" ]; then
  if [ -f "$AGE_RECIPIENTS_FILE" ]; then
    command -v age > /dev/null 2>&1 || {
      echo "chyba: $AGE_RECIPIENTS_FILE existuje, ale 'age' nie je nainštalované" >&2
      exit 1
    }
  else
    command -v gpg > /dev/null 2>&1 || {
      echo "chyba: 'gpg' nie je nainštalované — zálohovanie $ENV_SRC by zlyhalo" >&2
      exit 1
    }
  fi
fi

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
if [ -f "$ENV_SRC" ]; then
  if command -v age > /dev/null 2>&1 && [ -f "$AGE_RECIPIENTS_FILE" ]; then
    age -R "$AGE_RECIPIENTS_FILE" -o "$DIR/forestshop-$STAMP.env.age" "$ENV_SRC"
  else
    PASS_NEWLY_GENERATED=0
    if [ ! -f "$PASS_FILE" ]; then
      umask 077
      head -c 32 /dev/urandom | base64 > "$PASS_FILE"
      chmod 600 "$PASS_FILE"
      PASS_NEWLY_GENERATED=1
    fi

    # Heslo je JEDINÝ kľúč k .env — bez kópie mimo dev2 by strata tohto stroja
    # urobila .env.gpg navždy nerozšifrovateľným. Over/obnov ju pri KAŽDOM
    # behu (nielen pri založení), pred tým, než sa táto záloha vôbec označí
    # za dôveryhodnú.
    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_HOST" "test -s $BACKUP_REMOTE_DIR/.backup-passphrase" 2>/dev/null; then
      ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_HOST" "mkdir -p $BACKUP_REMOTE_DIR"
      rsync -a "$PASS_FILE" "$BACKUP_HOST:$BACKUP_REMOTE_DIR/.backup-passphrase"
      ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_HOST" "chmod 600 $BACKUP_REMOTE_DIR/.backup-passphrase"

      if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_HOST" "test -s $BACKUP_REMOTE_DIR/.backup-passphrase" 2>/dev/null; then
        echo "záloha zlyhala — heslo na dešifrovanie .env sa nepodarilo overiteľne skopírovať na $BACKUP_HOST; záloha, ktorú nemožno rozšifrovať, nie je záloha" >&2
        exit 1
      fi

      if [ "$PASS_NEWLY_GENERATED" -eq 1 ]; then
        cat >&2 <<NOTICE
UPOZORNENIE: toto je prvý beh zálohy — práve sa vytvorilo heslo na šifrovanie
.env súboru. Heslo teraz existuje na DVOCH miestach:
  - $PASS_FILE (na tomto stroji, dev2)
  - $BACKUP_HOST:$BACKUP_REMOTE_DIR/.backup-passphrase (mimo dev2, na dev1)
Netreba nič robiť ručne — kópia na dev1 prežije aj úplnú stratu dev2. Len ju
tam nezmazať; bez nej sa zašifrovaný .env z ďalších záloh nedá rozšifrovať.
NOTICE
      fi
    fi

    gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS_FILE" \
      --output "$DIR/forestshop-$STAMP.env.gpg" "$ENV_SRC"
  fi
else
  echo "upozornenie: $ENV_SRC neexistuje, zálohuje sa iba databáza" >&2
fi

# záloha je bezcenná, kým leží na tom istom stroji ako dáta
rsync -a "$DIR"/forestshop-"$STAMP".* "$BACKUP_HOST:$BACKUP_REMOTE_DIR/"

find "$DIR" -name 'forestshop-*.dump' -mtime +14 -delete
find "$DIR" -name 'forestshop-*.env.age' -mtime +14 -delete
find "$DIR" -name 'forestshop-*.env.gpg' -mtime +14 -delete
echo "záloha hotová: forestshop-$STAMP.dump"
