---
paths:
  - "scripts/backup-db.sh"
  - "scripts/backup-db-local.sh"
  - "scripts/restore-drill.sh"
---

# Backups

**Primárne zálohovanie živých dát je odteraz na `forestshop-dev`** (issue
366/367, 12. 8. 2026) — appka aj Postgres so živými dátami tam odvtedy
bežia. **dev2 ostáva bežať ďalej, ale už len ako STATICKÁ rollback kópia**
(appka a cloudflared tam boli pri presune odstránené, `forestshop-postgres-1`
tam beží ďalej podľa výslovného rozhodnutia majiteľa a jeho dáta sa už
nemenia) — mechanizmus nižšie v sekcii "dev2" je nezmenený a stále beží
presne tak, ako je zdokumentovaný, len prestal byť zdrojom aktuálnych dát.

## Primárne zálohovanie — forestshop-dev (živé dáta)

**Smer je PULL, nie PUSH** — `forestshop-dev` (178.105.89.168) nemá žiadnu
sieťovú cestu k dev1 (žiadny tailscale klient, dev1 nemá verejnú adresu), a
teda dev2's PUSH prístup (pozri "dev2" nižšie) by tu vždy zlyhal timeoutom.
Smer je preto obrátený:

- **`/srv/forestshop/scripts/backup-db-local.sh`** (pridané do repa pri
  issue 366 — inak by ho `deploy.yml`'s `rsync -a --delete` z repového
  `scripts/` pri najbližšom nasadení potichu zmazal, keďže by existoval len
  na serveri) beží cez cron `15 2 * * *`, **box-lokálny čas — POZOR, mení
  sa v čase, over vždy znova `timedatectl` pred prepočtom na UTC.** K
  12. 8. 2026 21:xx (issue 376, overené priamo) `/etc/localtime` ukazuje na
  `Europe/Bratislava` (aktuálne CEST, +02:00) — symlink bol podľa jeho
  vlastného mtime zmenený TEN ISTÝ DEŇ o 18:29 CEST, teda box krátko po
  svojom vzniku (issue 366, ráno 12. 8.) skutočne bežal na UTC (odtiaľ
  pôvodná, teraz už neplatná poznámka "systémový čas je `Etc/UTC`"), no
  odvtedy sa preklopil na Bratislava-local. `/etc/timezone` (súbor, ktorý
  cron NEČÍTA — použitý je `/etc/localtime`) ostáva zastarane na
  `Etc/UTC` a nie je spoľahlivý zdroj. Praktický dôsledok: dnes v noci
  (12.→13. 8.) tento cron prvýkrát reálne pobeží o **02:15
  Europe/Bratislava-local = 00:15 UTC v CEST** (v CET by to bolo 01:15
  UTC) — NIE o 02:15 UTC, ako tvrdila pôvodná verzia tohto bulletu. Robí
  LEN lokálnu časť: `pg_dump -Fc` databázy → over
  `pg_restore --list` PRED čímkoľvek ďalším (poškodený/prázdny dump zastaví
  skript hneď, `exit 1`, nikdy sa neoznačí za platný) → zašifruje `.env`
  (`gpg --symmetric`, heslo v `/srv/forestshop/.backup-passphrase`, mode
  600 — nakopírované jednorazovo RUČNE z existujúcej kópie na dev1, rovnaké
  heslo ako dev2, SHA-256 overené) → zmaže staršie ako 14 dní. Výstup:
  `/srv/forestshop/backups/forestshop-<STAMP>.dump` + `.env.gpg`.
- **dev1 si súbory STIAHNE vlastným pull cronom** —
  `~/backups/pull-forestshop-dev-backup.sh` (žije len na dev1, mimo tohto
  repa). **Presný čas dev1's crontabu je OVERENÝ** (issue 376, overené
  13. 8. 2026 z prvej reálnej noci 12.→13. 8. 2026): cron beží
  **`30 4 * * *` Bratislava-local = 04:30 Europe/Bratislava = 02:30 UTC
  (v CEST).** `ssh dev1`/`ssh 100.104.8.125` z tohto boxu naozaj zlyhávajú
  (žiadna sieťová cesta, potvrdené), no overilo sa to NEPRIAMO —
  `forestshop-dev`'s vlastný `auth.log` zaznamenáva KAŽDÉ prihlásenie
  reštrikovaným pull kľúčom aj s presným časom. Postup, opakovateľný
  kýmkoľvek na tomto boxi:
  1. zisti fingerprint kľúča z `~/.ssh/authorized_keys` (riadok
     `command="/usr/bin/rrsync -ro ..." ssh-ed25519 ...
     forestshop-dev-backup-pull@dev1`) cez `ssh-keygen -lf`;
  2. `sudo grep '<fingerprint>' /var/log/auth.log` — každý riadok
     `Accepted publickey for admin ... ssh2: ED25519 SHA256:<fingerprint>`
     je jeden reálny pull, s UTC časovou pečiatkou v samotnom logu
     (nezávisle od box-lokálneho `timedatectl` nastavenia vyššie).
     **POZOR na formát:** tento box's `auth.log` má ISO časové pečiatky
     (`2026-08-13T02:30:02...`), NIE tradičný syslog tvar (`Aug 13 ...`) —
     `grep 'Aug 13'` nenájde nič, hľadaj rok-mesiac-deň prefix (`2026-08-`).

  K 12. 8. 2026 19:xx (deň, keď box vôbec prvýkrát začal bežať ako
  `forestshop-dev` — `journalctl --list-boots` ukazuje prvý boot tejto
  identity 12. 8. 2026 13:14 CEST) tento postup našiel presne 7 úspešných
  prihlásení tým kľúčom, VŠETKY zhlukovo medzi 12:46:44–13:06:03 UTC toho
  istého dňa — zjavne ručné testovanie pri zapájaní (issue 366/367 setup:
  7× pripojenie za 20 minút, nie raz-denne opakovaný cron vzor), takže
  vtedy skutočný cyklus ešte nemal dôkaz — nočné okno v tejto podobe boxu
  ešte vôbec nenastalo. **Prvá reálna noc (12.→13. 8. 2026) to potvrdila:**
  ten istý kľúč sa prihlásil PRESNE RAZ, z `85.248.11.235`, s časovou
  pečiatkou `Accepted publickey ...` **2026-08-13T02:30:02** v `auth.log`
  (= 02:30 UTC = 04:30 Europe/Bratislava v CEST). To potvrdzuje hypotézu
  cronu `30 4 * * *` Bratislava-local (a vyvracia dovtedy súbežne
  zvažovanú hypotézu ~02:25 UTC z `backup-db-local.sh`'s hlavičkového
  komentára).
  Cieľ na dev1: **`~/backups/forestshop-dev/`** — samostatný adresár,
  ODDELENE od dev2's `~/backups/forestshop/` (nižšie), aby sa dve
  nezávislé zálohovacie histórie nikdy nepomiešali.
- **Prístup je READ-ONLY a scopovaný na jeden adresár.** Dedikovaný SSH
  kľúč `~/.ssh/forestshop_dev_backup_pull` na dev1, na strane
  `forestshop-dev` reštrikovaný v `authorized_keys` cez
  `command="/usr/bin/rrsync -ro /srv/forestshop/backups/",restrict` — žiadny
  shell, žiadny zápis, žiadny prístup mimo `backups/`. Živo overené priamo
  na `forestshop-dev`: presne tento riadok je v `~/.ssh/authorized_keys`.
- **Retencia:** 14 dní na zdroji (`forestshop-dev` — rovnaká politika ako
  dev2, pozri `backup-db-local.sh`'s `find ... -mtime +14 -delete`), na
  dev1 sa nemaže (rovnaká politika ako dev2's archív nižšie).
- **Obnova na úplne novom stroji** postupuje rovnakými krokmi ako dev2's
  postup nižšie (nájdi posledný STAMP → stiahni dump + `.env.gpg` +
  heslo → rozšifruj → over `pg_restore --list` → obnov cez
  `restore-drill.sh`/priamym `pg_restore` → nasaď `.env` → `docker compose
  up -d`) — jediný rozdiel je zdrojový adresár na dev1
  (`~/backups/forestshop-dev/` namiesto `~/backups/forestshop/`). Presný
  skriptovaný postup (scp príkazy, ssh cieľ) je zdokumentovaný len pre
  dev2's `backup-db.sh` (hlavičkový komentár, pozri nižšie) — pre
  `forestshop-dev` treba scp/ssh príkazy z toho istého postupu prepísať na
  `~/backups/forestshop-dev/` ako zdrojový adresár.

**Čo bolo overené naživo a čo nie:** Táto relácia beží priamo na
`forestshop-dev`, takže box's vlastná strana (crontab, obsah skriptu,
`authorized_keys`, reálne súbory v `/srv/forestshop/backups/` — napr.
`forestshop-20260812T130301.dump` + `.env.gpg` z behu 12. 8. 2026) je overená
priamym čítaním, nie len z textu tiketu. **dev1-strana priamo (jeho vlastný
crontab súbor, obsah `~/backups/forestshop-dev/`) sa naďalej NEDÁ overiť z
tohto stroja** — `forestshop-dev` nemá k dev1 žiadnu sieťovú cestu (`ssh
dev1`/`ssh 100.104.8.125` obe zlyhali). **Dev1's SKUTOČNÉ SPRÁVANIE (kedy sa
naozaj pripája) sa ale DÁ overiť nepriamo** cez `forestshop-dev`'s vlastný
`auth.log` (issue 376 — postup + overený výsledok pozri bullet "dev1 si
súbory STIAHNE" vyššie): prvá reálna noc (12.→13. 8. 2026) potvrdila cron
`30 4 * * *` Bratislava-local (04:30 = 02:30 UTC v CEST).

## dev2 (statická rollback kópia)

- **Nočný beh (`scripts/backup-db.sh`, cron na dev2, `15 2 * * *`) robí DVE
  veci:** `pg_dump -Fc` databázy a šifrovanú kópiu `/srv/forestshop/.env`
  (obsahuje `POSTGRES_PASSWORD` + `CF_TUNNEL_TOKEN` — bez nich by obnovený
  dump bol na nič, nová inštancia by sa nevedela pripojiť ani spustiť
  tunel). Šifrovanie: `age -R <recipients>` ak je nastavený
  `/srv/forestshop/.backup-age-recipients` (operátor drží súkromný kľúč
  MIMO dev2), inak `gpg --symmetric` s heslom v
  `/srv/forestshop/.backup-passphrase` (mode 600, auto-generované pri prvom
  behu). K 2026-07-29 dev2 nemá `age` nastavené — beží gpg vetva.
- **Dump aj šifrovaný `.env` (a pri gpg-vetve aj samotné heslo) sa kopírujú
  na dev1** (`newlevel@100.104.8.125` — Tailscale IP, NIE bare hostname
  `dev1`; MagicDNS je tenantovo zapnuté, ale `tailscale0` na dev2 nemá
  nastavený žiadny DNS scope, takže bare meno sa odtiaľ nedá vyriešiť).
  Cieľ na dev1: `~/backups/forestshop/`.
- **Dump sa validuje `pg_restore --list` PRED kopírovaním na dev1 a PRED
  mazaním starých záloh** (`find ... -mtime +14 -delete`, 14 dní retencia)
  — poškodený/prázdny dump zastaví skript hneď (`exit 1`), nikdy sa
  nekopíruje ani sa kvôli nemu nezmažú ešte platné staršie zálohy.
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
