---
paths:
  - "scripts/backup-db.sh"
  - "scripts/restore-drill.sh"
---

# Backups

- **Nočný beh (`scripts/backup-db.sh`, cron na dev2, `15 2 * * *`) robí DVE
  veci:** `pg_dump -Fc` databázy a šifrovanú kópiu `/srv/forestshop/.env`
  (obsahuje `POSTGRES_PASSWORD` + `CF_TUNNEL_TOKEN` — bez nich by obnovený
  dump bol na nič, nová inštancia by sa nevedela pripojiť ani spustiť tunel).
  Šifrovanie: `age -R <recipients>` ak je nastavený
  `/srv/forestshop/.backup-age-recipients` (operátor drží súkromný kľúč MIMO
  dev2), inak `gpg --symmetric` s heslom v
  `/srv/forestshop/.backup-passphrase` (mode 600, auto-generované pri prvom
  behu). K 2026-07-29 dev2 nemá `age` nastavené — beží gpg vetva.
- **Dump aj šifrovaný `.env` (a pri gpg-vetve aj samotné heslo) sa kopírujú na
  dev1** (`newlevel@100.104.8.125` — Tailscale IP, NIE bare hostname `dev1`;
  MagicDNS je tenantovo zapnuté, ale `tailscale0` na dev2 nemá nastavený
  žiadny DNS scope, takže bare meno sa odtiaľ nedá vyriešiť). Cieľ na dev1:
  `~/backups/forestshop/`.
- **Dump sa validuje `pg_restore --list` PRED kopírovaním na dev1 a PRED
  mazaním starých záloh** (`find ... -mtime +14 -delete`, 14 dní retencia) —
  poškodený/prázdny dump zastaví skript hneď (`exit 1`), nikdy sa nekopíruje
  ani sa kvôli nemu nezmažú ešte platné staršie zálohy.
- **Heslo na dešifrovanie sa pri KAŽDOM behu (nielen pri prvom) overí, že
  existuje a je neprázdne na dev1** (`ssh ... test -s`), a ak sa kópia nedá
  spraviť/overiť, skript zlyhá nahlas namiesto tichého vytvorenia zálohy,
  ktorú by nikto nevedel rozšifrovať.
- **Presný postup obnovy na úplne novom stroji** (dev2 stratený) je
  zdokumentovaný priamo v hlavičkovom komentári `scripts/backup-db.sh` — 6
  krokov: zisti posledný STAMP na dev1 → stiahni dump + `.env.gpg`/`.env.age`
  + (pri gpg) heslo → rozšifruj `.env` → over dump `pg_restore --list` →
  obnov dáta cez `scripts/restore-drill.sh <dump>` (jednorazový kontajner,
  `--no-owner --no-privileges` — dump obsahuje `ALTER ... OWNER TO
  forestshop`, no drill kontajner tú rolu nemá) alebo priamym `pg_restore` do
  nového produkčného Postgresu → nasaď rozšifrovaný `.env` na
  `/srv/forestshop/.env` (mode 600) → `docker compose -f
  docker-compose.prod.yml up -d`.
- **`restore-drill.sh` odmieta prevziať existujúci kontajner `drill-pg`**
  (skontroluje PRED vytvorením, `EXIT` trap sa registruje až PO tom, čo skript
  potvrdí, že kontajner vytvoril sám) — inak by mohol na `EXIT` zmazať cudzí
  kontajner toho istého mena.
- Žiadne heslo/passphrase/token sa v repe (ani v tomto rule súbore) nevypisuje
  ako hodnota — len cesty k súborom a názvy premenných.
