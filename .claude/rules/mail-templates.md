---
paths:
  - "apps/api/src/modules/mail-templates/**"
  - "apps/api/src/http/mail-template-routes.ts"
  - "apps/api/src/db/schema-mail-templates.ts"
  - "apps/web/src/mailTemplatesApi.ts"
  - "apps/web/src/components/MailTemplate*.tsx"
  - "apps/web/tests/e2e/mail-templates.spec.ts"
  - "apps/api/src/http/login-rate-limit.ts"
---

# Upraviteľné znenia e-mailov (issue 192)

- **Pôvodné znenie žije V KÓDE (`registry.ts`), nikdy sa nekopíruje do
  databázy.** Riadok v `mail_template` existuje LEN pre šablónu, ktorú majiteľ
  naozaj zmenil; `resolveTemplate` vracia `riadok ?? defaultText`. Vďaka tomu
  je "vrátiť pôvodné znenie" obyčajné `DELETE` a pôvodné texty nemôžu zastarať
  oproti kódu. **Seedovanie pôvodných znení migráciou by presne to pokazilo** —
  po zmene textu v kóde by v databáze naďalej platila stará kópia a nikto by
  si toho nevšimol. Pri pridaní ĎALŠIEHO druhu e-mailu stačí položka v
  `MAIL_TEMPLATE_KEYS` + `KINDS`, žiadna migrácia.
- **Odosielacie cesty vždy prechádzajú cez `resolveTemplate`, nikdy nečítajú
  `mailTemplates` priamo** — priamy `select` by stratil fallback na pôvodné
  znenie a poslal by prázdny e-mail.
- **Šablónu načítaj RAZ pred cyklom, nie v ňom** (`order-reminder/run.ts`'s
  `reminderTemplate`): jeden beh pošle desiatky e-mailov a znenie sa počas
  neho meniť nemá — plus je to jeden DB dopyt namiesto N.
- **`**tučné**` sa spracúva ako DVOJICA ZNAČIEK v prúde útržkov, nie regulárnym
  výrazom nad reťazcom.** Hviezdičky bežne obklopujú zástupné pole
  (`**{{meno_zakaznika}}**`), takže otváracia a zatváracia padnú do DVOCH
  RÔZNYCH doslovných útržkov; regex ich nespáruje a namiesto toho spáruje
  zatváraciu s otváracou o niekoľko odstavcov nižšie — výsledkom bolo
  `<p>Dobrý deň, **zákazník<strong>,</p>` a `</strong>Drlík...**` (chytil to
  existujúci test `nedostupne/logic.test.ts` hneď pri prechode na šablóny).
  Nedovretá značka sa uzatvára na konci odstavca, aby sa rozbité HTML nikdy
  nedostalo k zákazníkovi.
- **Zalomenia a odstavce vznikajú VÝHRADNE z doslovného textu šablóny, nikdy
  z dosadenej hodnoty.** Preto sa neskladá jeden reťazec, ktorý by sa potom
  delil, ale postupnosť útržkov (`frag`/`bold`/`br`/`par`/`list`) — inak by
  viacriadková hodnota poľa (zoznam náhrad) sama zakladala odstavce.
- **Escapovanie je na strane appky, značky smie zapísať len šablóna.** Hodnota
  poľa sa escapuje pri dosadení a hviezdičky v nej NEformátujú — inak by meno
  zákazníka vedelo do e-mailu prepašovať HTML. Testy na to sú v
  `render.test.ts` ("bezpečnosť").
- **`registry.test.ts` je poistka, že pôvodné znenie nemôže vyjsť pokazené** —
  prechádza tou istou kontrolou (`validateTemplateText`) ako uložená šablóna.
  Pôvodné znenia sa totiž nikdy neukladajú, takže by ich preklep inak odhalil
  až zákazník. Nová šablóna = nový riadok v tomto teste automaticky (`it.each`
  nad `MAIL_TEMPLATE_KEYS`).
- **Eskalácia zásielkových e-mailov ostáva ŠTYRMI samostatnými šablónami**
  (`posta_1..posta_4`, výber cez `postaTemplateKey(count)`). Zlúčiť ich do
  jednej by ticho zahodilo štyri rôzne znenia, ktoré appka dnes posiela.
- **Podmienka `{{#ak pole}}…{{inak}}…{{/ak}}` nie je zbytočná zložitosť** —
  dnešné texty ju reálne obsahujú (zásielka s termínom vyzdvihnutia vs. bez
  neho, náhrady vs. bez náhrad). Bez nej by prechod na šablóny ticho zmenil
  správanie. Vnorenie je zakázané a kontroluje sa pri uložení.
- **Objednávka dodávateľovi je JEDINÝ čisto textový e-mail** — jej pôvodné
  telo je "predmet, JEDNO zalomenie, zoznam položiek", takže výsledok ostáva
  bajt na bajt rovnaký ako predtým (`orders/mail.test.ts` to drží). Zoznam
  položiek preto nemá odrážkovú predponu, kým `zoznam_nahrad` má `"- "`
  (predpona je vlastnosťou HODNOTY, nie enginu).
- **Očakávané doménové zlyhanie vracia 200 s `{ok:false, error}`** (neznámy
  druh e-mailu, neplatná šablóna) — nikdy 4xx, inak Chromium zaloguje
  konzolovú chybu a e2e balík s nulovou toleranciou spadne
  (`.claude/rules/testing.md`).
- **E2E balík narazil na strop 30 prihlásení na IP za 5 minút**
  (`IP_MAX_ATTEMPTS`, `login-rate-limit.ts`) — všetkých ~30 prihlásení celého
  behu prichádza z JEDNEJ adresy (localhost), takže limit narazil zo svojej
  podstaty, nie kvôli útoku. Prejaví sa ako "Nesprávny e-mail alebo heslo" v
  NÁHODNOM neskoršom spec súbore, nikdy v tom, ktorý login pridal. Riešenie:
  strop je premennou prostredia `LOGIN_IP_MAX_ATTEMPTS` (produkčná predvolená
  hodnota 30 sa nemení, `playwright.config.ts` ju pre testovací server dvíha).
  Limit na (IP, e-mail) pár — ten, čo chráni konkrétny účet — sa NEMENÍ ani v
  testoch, takže vlastný izolovaný účet pre nový spec súbor je stále povinný.
  **Nový e2e test aj tak nepridávaj s vlastným prihlásením zbytočne** — dva
  scenáre v jednom teste sú lacnejšie než dve prihlásenia.
- **issue 277: `renderEditedBody` (`render.ts`) je zámerne SAMOSTATNÁ od
  `renderTemplate` — jednorazová ručná úprava (okno náhľadu pred
  odoslaním, `.claude/rules/nedostupne.md`) edituje UŽ HOTOVÝ text
  (placeholdery dosadené), takže sa nepúšťa cez `parse`/`{{pole}}`/
  `**tučné**` engine znova (obsluha nepozná/nepotrebuje šablónovú
  syntax). Zdieľa len `htmlEscape` (exportovaná z `render.ts` kvôli
  tomu) — prázdny riadok = odstavec, rovnaká konvencia ako šablóny,
  jednoduchý riadok = `<br>`.
- **issue 238: `samples.ts`'s "náhľad na skutočných dátach" pre
  `nedostupne_alternativa`'s `zoznam_nahrad` teraz vychádza z
  `nedostupne_replacement_link` (majiteľove ručné odkazy), nie z pôvodného
  `product.relatedCodes` návrhu.** `productSample` vracia aj `variant.code`
  (predtým len `name`) — presne TEN variant, ktorého manuálne odkazy
  `replacementLinkSample` vyhľadá. Rovnaký "vzorka nikdy nespadne, len
  ukáže ukážkovú hodnotu z registra" kontrakt platí ďalej (nič nezmenené v
  `try/catch` obale `previewContext`u).
- **issue 347: JEDNA zdieľaná HTML kostra (`layout.ts`'s `wrapEmailHtml`) —
  hlavička + oddelená pätička (telefón/e-mail/web) — obaľuje KAŽDÝ
  vyrenderovaný e-mail, volaná z DVOCH miest (`assembleHtml`,
  `renderEditedBody`), nikdy z jednotlivých šablón/odosielateľov.**
  `orders/mail.ts`'s `supplier_order` (jediný čisto textový e-mail) ostáva
  bajt na bajt nedotknutý — posiela výhradne `.text`, na `.html` sa nikto
  nikdy nepozrie, takže kostra sa naň de facto nikdy neuplatní, hoci sa
  technicky vypočíta.
- **issue 347: `TemplateListItem` (render.ts) má voliteľné `imageUrl`/
  `priceText` — zoznam, kde AKÝKOĽVEK prvok nesie `imageUrl`, sa v HTML
  vykreslí ako "produktová karta" (obrázok + klikací NÁZOV + cena +
  tlačidlo) namiesto `<ul><li>`. Zoznam BEZ `imageUrl` na žiadnom prvku
  (napr. `orders/mail.ts`'s `zoznam_poloziek`) ostáva úplne nezmenený —
  toto je opt-in rozšírenie, nie zmena existujúceho správania.** Text-verzia
  (`assembleText`) dáva pri prvku s `url` NÁZOV a ADRESU na samostatné
  riadky (nikdy `"názov (url)"`) — platí pre KAŽDÝ zoznam s `url`, nielen
  karty; pri prvku bez `url` sa nič nemení.
- **issue 347: `MailTemplateEditor.tsx`'s preview injektuje celé `html`
  (vrátane `<!DOCTYPE html><html><body style="...">`) cez
  `dangerouslySetInnerHTML` do `<div>`.** Fragment-parsing algoritmus
  prehliadača `<html>`/`<body>` značky ZAHODÍ, takže štýl na `<body>`
  (pozadie stránky, padding) sa v NÁHĽADE v appke NIKDY neuplatní — v
  skutočnom e-mailovom klientovi (celý HTML dokument) áno. Toto je
  PREDOŠLÝ, nezmenený limit (platil aj pred issue 347), nie regresia —
  preto `wrapEmailHtml` štýluje hlavičku/pätičku/kartu na VNORENÝCH
  `<table>`/`<td>` elementoch (tie fragment-parsing prežijú nedotknuté),
  nikdy na `<body>` samotnom.
- **Naživo overiť kartu s obrázkom vyžaduje `shop_product_url.image_url`
  vyplnený — appka nemá "spusti teraz" tlačidlo pre `shop-feed` job
  (`.claude/rules/scheduler.md`), takže po deployi treba manuálne spustiť
  presne tú istú cestu, akú beží nočný job, priamo v kontajneri
  (`docker exec forestshop-app-1 node -e "..."`, plný príkaz v
  `.claude/rules/shop-feed.md`) — legitímne, nedeštruktívne (rovnaký
  UPSERT ako plánovaný beh), nie obchádzka.
