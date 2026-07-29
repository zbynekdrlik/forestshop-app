#!/usr/bin/env bash
set -euo pipefail

STAMP=$(date +%Y%m%dT%H%M%S)
DIR=/srv/forestshop/backups
mkdir -p "$DIR"
docker compose -f /srv/forestshop/docker-compose.prod.yml exec -T postgres \
  pg_dump -U forestshop -Fc forestshop > "$DIR/forestshop-$STAMP.dump"

# záloha je bezcenná, kým leží na tom istom stroji ako dáta
# (dev1 = 100.104.8.125 cez Tailscale — bare meno "dev1" sa na dev2 nedá vyriešiť,
# MagicDNS beží tenantovo, ale tailscale0 tu nemá nastavený žiadny DNS scope)
rsync -a "$DIR/forestshop-$STAMP.dump" newlevel@100.104.8.125:~/backups/forestshop/

find "$DIR" -name 'forestshop-*.dump' -mtime +14 -delete
echo "záloha hotová: forestshop-$STAMP.dump"
