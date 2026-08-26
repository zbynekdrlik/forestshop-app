import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Obsahuje prihlasovací `hash` — patrí LEN do .env na dev2 a do GitHub Secrets.
  // Nepovinná: bez nej appka beží, len ručný import vráti 503.
  SHOPTET_EXPORT_URL: z.string().url().optional(),
  CATALOG_RAW_DIR: z.string().min(1).default("./data/catalog-raw"),
  // Rovnaké pravidlo ako SHOPTET_EXPORT_URL vyššie — `hash` v query parametri
  // je prihlasovací údaj, nikdy sa nezapisuje do repa. Nepovinná (#21): bez
  // nej appka beží ďalej, len CLI import objednávok zlyhá nahlas hneď na štarte.
  SHOPTET_ORDERS_URL: z.string().url().optional(),
  // issue 120: SAMOSTATNÝ XML export objednávok (`patternId=-11`) — jediný
  // zdroj interného Shoptet id (CSV export vyššie ho nenesie vôbec). Rovnaké
  // pravidlo ako `SHOPTET_ORDERS_URL`: `hash` je prihlasovací údaj, nikdy do
  // repa. Nepovinná: bez nej appka beží ďalej presne ako doteraz (odkaz na
  // objednávku len na vyhľadávanie, `modules/orders/queries.ts`), len bez
  // tejto premennej nikdy nezíska interné id na priamy odkaz na detail.
  SHOPTET_ORDERS_XML_URL: z.string().url().optional(),
  ORDERS_RAW_DIR: z.string().min(1).default("./data/orders-raw"),

  // Feed pre porovnávače, z ktorého sa berie mapa „kód → adresa detailu"
  // (issue 220). Na rozdiel od `SHOPTET_EXPORT_URL` je VEREJNÝ a nenesie
  // prihlasovací údaj, takže má predvolenú hodnotu v kóde
  // (`DEFAULT_SHOP_FEED_URL`) — premenná je len poistka pre prípad zmeny
  // adresy na strane Shoptetu.
  SHOP_FEED_URL: z.string().url().optional(),
  // issue 65: základ Shoptet-ovho ADMIN rozhrania (nie exportu) pre priamy
  // odkaz na objednávku z obrazovky "Na objednanie" — na rozdiel od
  // `SHOPTET_EXPORT_URL`/`SHOPTET_ORDERS_URL` vyššie NENESIE prihlasovací
  // `hash`, nie je to tajomstvo (je to len verejná doména obchodu). Má
  // rozumný default (skutočná produkčná hodnota), ale ostáva
  // premennou/konfigurovateľnou — nikdy natvrdo v kóde (`.claude/rules/
  // orders.md`'s zásada "admin base patrí do config/env").
  SHOPTET_ADMIN_BASE_URL: z.string().url().default("https://www.forestshop.sk"),
  // Odosielanie objednávky dodávateľovi mailom (#31) — rovnaký mechanizmus ako
  // stará appka (SMTP, env premenné). Nepovinné ako `SHOPTET_EXPORT_URL`
  // vyššie: bez `MAIL_HOST` appka beží ďalej, len odoslanie mailom vráti 503
  // (heslo/prihlasovacie údaje sú tiež nepovinné — niektoré SMTP relaye
  // nevyžadujú autentifikáciu).
  MAIL_HOST: z.string().min(1).optional(),
  MAIL_PORT: z.coerce.number().int().positive().default(587),
  MAIL_USER: z.string().optional(),
  MAIL_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  // issue 358: Reply-To, ZÁMERNE samostatná od `MAIL_FROM` (nie odvodená) —
  // aby odpoveď dorazila na správnu adresu, aj keby sa `MAIL_FROM` niekedy
  // zmenil. Bez nastavenia `createSmtpMailTransport` spadne späť na `from`
  // (`modules/mail/transport.ts`'s `resolveMailSender`).
  MAIL_REPLY_TO: z.string().optional(),
  // issue 122: spätný zápis odkazu na dodávateľa do Shoptetu cez hromadný CSV
  // import (Playwright). Skutočné prihlasovacie údaje — rovnaké pravidlo ako
  // `MAIL_PASS` vyššie, nikdy do repa/commit správy/logu. Obe nepovinné:
  // bez nich appka beží ďalej, naplánovaná úloha len zlyhá s vysvetlením
  // "nenakonfigurované" (rovnaký vzor ako `catalogImportJob`/`ordersImportJob`).
  SHOPTET_ADMIN_USER: z.string().min(1).optional(),
  SHOPTET_ADMIN_PASSWORD: z.string().min(1).optional(),
  // Alpine (produkčný Docker image) nemá Playwright's vlastný (glibc-only)
  // stiahnutý Chromium — `playwright-import.ts`'s `resolveChromiumExecutablePath`
  // namiesto neho použije apk-nainštalovaný systémový chromium. Nepovinné aj
  // tu — mimo produkčného image ho netreba, Playwright použije svoj vlastný.
  CHROMIUM_EXECUTABLE_PATH: z.string().min(1).optional(),
  // issue 172: skrytá kópia (BCC) majiteľovi pre "Nevyzdvihnuté zásielky" —
  // NEZÁVISLÁ, vyhradená premenná (nie všeobecné `MAIL_BCC`, `.claude/rules/
  // orders.md`'s poznámka o tom, prečo appka doteraz BCC vôbec nepodporuje).
  // Chýbajúca = automatizácia NEPOŠLE ani jeden e-mail zákazníkovi (fail-
  // closed, ticket's jediná bezpečnostná podmienka) — nikdy sa nedotýka
  // existujúceho odosielania objednávky dodávateľovi.
  POSTA_UNCOLLECTED_BCC_EMAIL: z.string().email().optional(),
  // issue 173: "Pripomienky objednávok" — OpenAI klasifikátor internej
  // poznámky predajne ("bol zákazník už kontaktovaný?"). Nepovinný: bez neho
  // automatizácia beží ďalej, len objednávky s poznámkou zostanú "čaká" (AI
  // nedostupné) namiesto klasifikácie — nikdy sa nehádaj/nepošle naslepo.
  // Skutočný kľúč patrí LEN do .env na dev2 a GitHub Secrets, nikdy do repa.
  OPENAI_API_KEY: z.string().min(1).optional(),
  // issue 173: skrytá kópia (BCC) majiteľovi — NEZÁVISLÁ, vyhradená premenná
  // (rovnaký dôvod ako #172's `POSTA_UNCOLLECTED_BCC_EMAIL`, nie zdieľané
  // všeobecné `MAIL_BCC`). Chýbajúca = automatizácia NEPOŠLE ani jeden e-mail
  // zákazníkovi (fail-closed, majiteľova jediná bezpečnostná podmienka).
  ORDER_REMINDER_BCC_EMAIL: z.string().email().optional(),
  // issue 176: "Nedostupné tovary" — skrytá kópia (BCC) majiteľovi, rovnaká
  // úvaha ako `POSTA_UNCOLLECTED_BCC_EMAIL`/`ORDER_REMINDER_BCC_EMAIL`
  // vyššie (NEZÁVISLÁ, vyhradená premenná, nikdy zdieľané všeobecné
  // `MAIL_BCC`). Chýbajúca = automatizácia NEPOŠLE ani jeden e-mail
  // zákazníkovi (fail-closed).
  NEDOSTUPNE_BCC_EMAIL: z.string().email().optional(),
  // issue 257: "Zlúčenie objednávky" — e-mail zákazníkovi, keď sa jeho
  // viaceré objednávky posielajú spolu ako jedna zásielka. Rovnaká úvaha ako
  // `NEDOSTUPNE_BCC_EMAIL` vyššie (NEZÁVISLÁ, vyhradená premenná, nikdy
  // zdieľané všeobecné `MAIL_BCC`). Chýbajúca = automatizácia NEPOŠLE ani
  // jeden e-mail zákazníkovi (fail-closed).
  ORDER_MERGE_BCC_EMAIL: z.string().email().optional(),
  // issue 500: "Na objednanie" — ručný e-mail zákazníkovi (@ tlačidlo na
  // riadku). Rovnaká úvaha ako `NEDOSTUPNE_BCC_EMAIL`/`ORDER_MERGE_BCC_EMAIL`
  // vyššie (NEZÁVISLÁ, vyhradená premenná, nikdy zdieľané všeobecné
  // `MAIL_BCC`). Chýbajúca = odoslanie NEODÍDE (fail-closed) a okno náhľadu
  // ukáže jasnú hlášku.
  ORDER_CUSTOMER_CONTACT_BCC_EMAIL: z.string().email().optional(),
  // issue 292: prihlasovacie údaje do portálu `dpdshipper.sk` (Playwright
  // robot na objednávanie prepravy/zvozu) — rovnaké pravidlo ako
  // `SHOPTET_ADMIN_USER`/`PASSWORD` vyššie, nikdy do repa/commit
  // správy/logu. Nepovinné: bez nich appka beží ďalej, "Preprava DPD"
  // obrazovka len ukáže "nenakonfigurované" namiesto tlačidiel na
  // odoslanie/zvoz.
  DPD_PORTAL_USER: z.string().min(1).optional(),
  DPD_PORTAL_PASSWORD: z.string().min(1).optional(),
  // Prihlasovacia URL portálu — nenesie žiadny tajný `hash`/token, ale
  // ostáva konfigurovateľná (rovnaký princíp ako `SHOPTET_ADMIN_BASE_URL`),
  // pre prípad zmeny adresy alebo testovacieho prostredia DPD.
  DPD_PORTAL_BASE_URL: z.string().url().default("https://www.dpdshipper.sk"),
  // issue 309/469: "Eshop → Upozornenia" — najbližšie udalosti z majiteľových
  // Google kalendárov. Tajné iCal adresy (nie API kľúč/OAuth token — pozri
  // návrhový komentár na tickete): NESÚ tajný token PRIAMO V CESTE (na
  // rozdiel od SHOPTET_EXPORT_URL, kde je tajomstvom len `hash` query
  // parameter), nikdy do repa/commit správy/logu. Nepovinná: bez nej appka
  // beží ďalej, karta sa na nástenke jednoducho nezobrazí (rovnaký fail-
  // graceful princíp ako SHOPTET_EXPORT_URL).
  //
  // issue 469: prijme VIAC adries oddelených čiarkou alebo novým riadkom
  // (spätne kompatibilné s jednou adresou → 1-prvkové pole). Každá položka sa
  // validuje ako URL; whitespace okolo sa oreže, prázdne aj duplicitné položky
  // sa vynechajú (duplikát by inak stiahol ten istý kalendár dvakrát a
  // zdvojil udalosti na karte). Chybová hláška pri neplatnej adrese NIKDY
  // neinterpoluje samotnú adresu (tajný token je v ceste —
  // `.claude/rules/calendar.md`). Výsledný typ je `string[] | undefined`.
  GOOGLE_CALENDAR_ICS_URL: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const urlSchema = z.string().url();
      const urls = [
        ...new Set(
          raw
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        ),
      ];
      if (urls.length === 0) return undefined;
      for (const url of urls) {
        if (!urlSchema.safeParse(url).success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "GOOGLE_CALENDAR_ICS_URL obsahuje neplatnú URL adresu (tajná adresa sa do hlášky zámerne nevypisuje)",
          });
          return z.NEVER;
        }
      }
      return urls;
    }),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Chybná konfigurácia prostredia: ${parsed.error.message}`);
  }
  return parsed.data;
}
