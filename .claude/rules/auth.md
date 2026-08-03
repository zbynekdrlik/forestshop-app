---
paths:
  - "apps/api/src/modules/auth/**"
  - "apps/api/tests/auth*.ts"
---

# Prihlásenie a heslá

- **V databáze môžu byť DVA tvary odtlačku hesla, nie jeden.** Účty prenesené
  zo starej Flask appky (#189) majú werkzeug scrypt tvar
  `scrypt:N:r:p$sol$hexOdtlacok` (soľ je obyčajný text, odtlačok vždy 64 B),
  nové účty majú argon2id. `verifyPassword` v `passwords.ts` sa rozhoduje
  podľa prefixu; starú cestu rieši `legacy-scrypt.ts`. Každý ďalší kód, čo sa
  pozerá na `users.password_hash`, musí počítať s oboma tvarmi, kým sa všetky
  tri prenesené účty aspoň raz neprihlásia — potom scrypt z produkcie zmizne
  sám a `legacy-scrypt.ts` sa dá odstrániť.
- **Prepis odtlačku patrí VÝHRADNE do `login`, až za overenie hesla.** Je to
  jediný okamih, keď je heslo v čitateľnej podobe známe. Nikdy ho nerob pred
  overením ani v inej vetve — nesprávne heslo by inak vedelo prepísať uložený
  odtlačok. Test `nesprávne heslo prenesený odtlačok nezmení`
  (`tests/auth.integration.test.ts`) presne toto stráži.
- **`promisify(scrypt)` z `node:util` stratí preťaženie s parametrami** —
  `tsc` potom hlási `Expected 3 arguments, but got 4`, keď odovzdáš
  `{N, r, p, maxmem}`. Riešenie je vlastný `new Promise` obal okolo `scrypt`,
  nie `as any`.
- **Node vyhlási chybu, keď `128 * N * r` presiahne `maxmem`.** Pri werkzeug
  parametroch (`32768:8:1`) to vyjde presne na predvolených 32 MiB, čiže na
  hrane — `maxmem` si preto nastav explicitne s rezervou. A parametre čítané
  z uloženého odtlačku VŽDY obmedz zhora: bez limitu si poškodený alebo
  podvrhnutý riadok vie vyžiadať výpočet na gigabajty pamäte.
- **Neúspešné prihlásenie musí trvať rovnako dlho pri známom aj neznámom
  e-maile** — preto `DUMMY_PASSWORD_HASH` v `service.ts`. Neoptimalizuj to
  preč skratkou na `user === undefined`, inak čas odozvy prezradí, ktoré
  e-maily v systéme existujú.
- **Reálne heslá ani odtlačky sa NIKDY nepíšu do repozitára, commit správy,
  PR ani ticketu** (`.claude/rules/sensitive-values.md`). Testy si odtlačok
  vyrobia cez `createLegacyScryptHash` / `hashPassword`; prenos skutočných
  účtov na produkciu prebieha priamo na serveri cez SQL súbor, ktorý sa hneď
  po behu maže a nikdy sa nevypisuje na obrazovku.
