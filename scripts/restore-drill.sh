#!/usr/bin/env bash
set -euo pipefail

DUMP=${1:?použitie: restore-drill.sh <cesta-k-dumpu>}

# Ak kontajner drill-pg už existuje, nevieme, či ho vytvoril predchádzajúci
# (nedokončený) beh tohto skriptu alebo niečo úplne iné — v oboch prípadoch ho
# nesmieme na EXITe násilne zmazať, keby sme ho tu nevytvorili my. Radšej
# zlyhať hneď a nechať operátora rozhodnúť.
if docker ps -a --format '{{.Names}}' | grep -qx drill-pg; then
  echo "kontajner drill-pg už existuje (asi z predošlého nedokončeného behu) — over ho a prípadne zmaž ručne: docker rm -f drill-pg" >&2
  exit 1
fi

docker run --rm -d --name drill-pg -e POSTGRES_PASSWORD=drill -p 127.0.0.1:5599:5432 postgres:18-alpine
trap 'docker rm -f drill-pg > /dev/null 2>&1 || true' EXIT

# Obmedzený počet pokusov — bez neho by skript čakal navždy, keby sa kontajner
# nikdy nespustil (chýbajúci obraz, port už obsadený, pretečená disková kvóta…).
MAX_POKUSOV=60
pokus=0
until docker exec drill-pg pg_isready -U postgres > /dev/null 2>&1; do
  pokus=$((pokus + 1))
  if [ "$pokus" -ge "$MAX_POKUSOV" ]; then
    echo "drill-pg sa nestihol spustiť do $MAX_POKUSOV sekúnd" >&2
    exit 1
  fi
  sleep 1
done

# --no-owner/--no-privileges: dump obsahuje ALTER ... OWNER TO forestshop, ale
# jednorazový drill kontajner rolu "forestshop" nemá — obnova prebehne pod "postgres".
docker exec -i drill-pg pg_restore -U postgres -d postgres --clean --if-exists --no-owner --no-privileges < "$DUMP"
POCET=$(docker exec drill-pg psql -U postgres -tAc "select count(*) from users")
echo "obnovených používateľov: $POCET"
[ "$POCET" -gt 0 ] || { echo "obnova zlyhala — v zálohe nie sú používatelia" >&2; exit 1; }
