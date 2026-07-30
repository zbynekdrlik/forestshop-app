---
paths:
  - "docs/**"
  - ".claude/**"
---

## Skutočné heslá a tokeny nikdy nejdú do repozitára

Vyplynulo z #40 (živé heslo majiteľa v čistom texte v `docs/autopilot-log.md`,
zavedené počas overovania #18 na produkcii — muselo sa rotovať, keď to
pred zverejnením repa odhalil audit).

- **Skutočné heslá, tokeny, API kľúče a Shoptet exportné `hash=`** sa NIKDY
  nezapisujú do žiadneho súboru v repozitári — ani do `docs/autopilot-log.md`,
  ani do playbook súborov (`.claude/rules/**`), ani do commit správ, PR
  popisov, GitHub issues/komentárov.
- Keď treba v playbooku/logu opísať, že sa heslo/token menilo alebo použilo pri
  overovaní na živom systéme, použi zástupný text `<heslo — mimo repozitára>`
  namiesto skutočnej hodnoty.
- Skutočné hodnoty žijú len:
  - v `/srv/forestshop/.env` (mode 600) na dev2, alebo
  - v lokálnej pamäti relácie (Claude memory), nikdy commitované.
- Pred pushom vždy skontroluj diff (`git diff --cached` / `git show`) na
  prítomnosť akejkoľvek reálnej citlivej hodnoty — najmä keď si práve
  rotoval/testoval heslo na živom nasadení.
