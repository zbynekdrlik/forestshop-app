#!/usr/bin/env bash
set -euo pipefail

DUMP=${1:?použitie: restore-drill.sh <cesta-k-dumpu>}
docker run --rm -d --name drill-pg -e POSTGRES_PASSWORD=drill -p 127.0.0.1:5599:5432 postgres:18-alpine
trap 'docker rm -f drill-pg >/dev/null' EXIT
until docker exec drill-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done


# --no-owner/--no-privileges: dump obsahuje ALTER ... OWNER TO forestshop, ale
# jednorazový drill kontajner rolu "forestshop" nemá — obnova prebehne pod "postgres".
docker exec -i drill-pg pg_restore -U postgres -d postgres --clean --if-exists --no-owner --no-privileges < "$DUMP"
POCET=$(docker exec drill-pg psql -U postgres -tAc "select count(*) from users")
echo "obnovených používateľov: $POCET"
[ "$POCET" -gt 0 ] || { echo "obnova zlyhala — v zálohe nie sú používatelia"; exit 1; }
