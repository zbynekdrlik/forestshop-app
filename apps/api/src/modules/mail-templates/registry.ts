import { globalContext } from "./context.js";
import type { MailTemplateText, TemplateValue } from "./render.js";

// issue 192: register všetkých druhov e-mailov, ktoré appka posiela — ich
// PÔVODNÉ znenie (doslovne prevzaté z pôvodných staviteľov v
// `nedostupne/logic.ts`, `order-reminder/logic.ts`, `posta-uncollected/
// logic.ts` a `orders/mail.ts`) plus zoznam polí, ktoré v danom druhu smú
// vystupovať.
//
// Pôvodné znenie žije TU, v kóde — nikdy sa nekopíruje do databázy. Vďaka
// tomu je "vrátiť pôvodné znenie" obyčajné zmazanie riadku a pôvodné texty
// nemôžu zastarať oproti kódu.
//
// Eskalácia pri nevyzdvihnutých zásielkach má ŠTYRI rôzne znenia (1., 2., 3.
// a posledná výzva) — sú to štyri samostatné šablóny, nie jedna. Zlúčiť ich
// by znamenalo stratiť správanie, ktoré appka dnes má.

export const MAIL_TEMPLATE_KEYS = [
  "nedostupne",
  "nedostupne_alternativa",
  "posta_1",
  "posta_2",
  "posta_3",
  "posta_4",
  "order_reminder",
  "supplier_order",
  "order_merge",
] as const;

export type MailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

export function isMailTemplateKey(value: string): value is MailTemplateKey {
  return (MAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export interface PlaceholderDef {
  readonly name: string;
  /** Ako sa pole volá v ponuke pre obsluhu — po slovensky, bez žargónu. */
  readonly label: string;
  /** Ukážková hodnota — použije sa v náhľade, keď skutočné dáta chýbajú. */
  readonly example: TemplateValue;
}

export interface MailTemplateKind {
  readonly key: MailTemplateKey;
  readonly label: string;
  readonly description: string;
  readonly ownPlaceholders: readonly PlaceholderDef[];
  readonly defaultText: MailTemplateText;
}

// Polia dostupné v KAŽDEJ šablóne — kontaktné údaje a odkaz na e-shop.
// Ukážkové hodnoty sú TIE ISTÉ, aké dostane skutočný e-mail (`context.ts`),
// aby sa náhľad nemohol rozísť s odoslaným znením.
const GLOBAL_VALUES = globalContext();

export const GLOBAL_PLACEHOLDERS: readonly PlaceholderDef[] = [
  { name: "kontakt_email", label: "Náš kontaktný e-mail (odkaz)", example: GLOBAL_VALUES["kontakt_email"] as TemplateValue },
  { name: "kontakt_telefon", label: "Náš telefón (odkaz)", example: GLOBAL_VALUES["kontakt_telefon"] as TemplateValue },
  { name: "web_forestshop", label: "Odkaz na www.forestshop.sk", example: GLOBAL_VALUES["web_forestshop"] as TemplateValue },
];

const MENO: PlaceholderDef = { name: "meno_zakaznika", label: "Meno zákazníka", example: { kind: "text", text: "Ján Novák" } };
const CISLO_OBJEDNAVKY: PlaceholderDef = {
  name: "cislo_objednavky",
  label: "Číslo objednávky",
  example: { kind: "text", text: "20260123" },
};

const PODPIS_TIM = ["S pozdravom,", "**Tím Forestshop.sk**", "{{web_forestshop}}"].join("\n");

const POSTA_PLACEHOLDERS: readonly PlaceholderDef[] = [
  MENO,
  { name: "cislo_zasielky", label: "Číslo zásielky", example: { kind: "text", text: "RR123456789SK" } },
  { name: "posta", label: "Názov pošty", example: { kind: "text", text: "Pošta Žilina 1" } },
  { name: "adresa_posty", label: "Adresa pošty (nemusí byť známa)", example: { kind: "text", text: "Sládkovičova 1, Žilina" } },
  {
    name: "termin_vyzdvihnutia",
    label: "Dátum, do kedy si ju možno vyzdvihnúť (nemusí byť známy)",
    example: { kind: "text", text: "12. 8. 2026" },
  },
  {
    name: "odkaz_sledovanie",
    label: "Odkaz na sledovanie zásielky",
    example: {
      kind: "link",
      url: "https://tandt.posta.sk/zasielky/RR123456789SK",
      label: "https://tandt.posta.sk/zasielky/RR123456789SK",
    },
  },
];

/** Spoločný úvod + záver zásielkových e-mailov — líšia sa len dvomi vetami
 * (predstavenie situácie a naliehavosť), presne ako v pôvodnom `buildEmail`. */
function postaBody(intro: string, urgency: string): string {
  return [
    "Dobrý deň, **{{meno_zakaznika}}**,",
    "",
    intro,
    "",
    urgency,
    "",
    "👉 Stav zásielky môžete sledovať tu: {{odkaz_sledovanie}}",
    "",
    "Ak máte akékoľvek otázky, pokojne nás kontaktujte na {{kontakt_email}}.",
    "",
    PODPIS_TIM,
  ].join("\n");
}

const POSTA_MIESTO = "na pošte **{{posta}}**{{#ak adresa_posty}} ({{adresa_posty}}){{/ak}}";

const KINDS: readonly MailTemplateKind[] = [
  {
    key: "nedostupne",
    label: "Nedostupný tovar — bez návrhu náhrady",
    description: "Ospravedlnenie zákazníkovi, keď objednaný tovar nie je dostupný a nevieme, kedy bude.",
    ownPlaceholders: [MENO],
    defaultText: {
      subject: "Informácia o dostupnosti vašej objednávky — Forestshop.sk",
      body: [
        "Dobrý deň, **{{meno_zakaznika}}**,",
        "",
        "veľmi sa ospravedlňujeme, ale tovar ktorý ste si objednali je momentálne nedostupný a nevieme kedy bude naskladnený. Z toho dôvodu nevieme Vašu objednávku úspešne vybaviť.",
        "",
        "S pozdravom,",
        "**Drlík, Forestshop.sk**",
        "{{web_forestshop}}",
      ].join("\n"),
    },
  },
  {
    key: "nedostupne_alternativa",
    label: "Nedostupný tovar — s návrhom náhrady",
    description: "To isté, ale so zoznamom náhradných produktov, ktoré k tovaru vedieme.",
    ownPlaceholders: [
      MENO,
      { name: "nazov_tovaru", label: "Názov nedostupného tovaru", example: { kind: "text", text: "Nohavice FOREST 1003" } },
      {
        name: "zoznam_nahrad",
        label: "Zoznam náhradných produktov (odkazy)",
        example: {
          kind: "list",
          textPrefix: "- ",
          items: [{ label: "Podkolienky BOBR", url: "https://www.forestshop.sk/vyhladavanie/?string=60116%2F90" }],
        },
      },
    ],
    defaultText: {
      subject: "Alternatívy k vášmu tovaru — Forestshop.sk",
      body: [
        "Dobrý deň, **{{meno_zakaznika}}**,",
        "",
        "Radi by sme vás informovali, že produkt **{{nazov_tovaru}}** z vašej objednávky je momentálne **nedostupný**.",
        "",
        "{{#ak zoznam_nahrad}}Radi by sme vám preto ponúkli tieto **alternatívne produkty**:{{inak}}Radi vám pomôžeme nájsť vhodnú alternatívu — stačí nás kontaktovať.{{/ak}}",
        "{{zoznam_nahrad}}",
        "",
        "Ak máte akékoľvek otázky, pokojne nás kontaktujte na {{kontakt_email}} alebo na telefónnom čísle {{kontakt_telefon}}.",
        "",
        "Ďakujeme vám za dôveru.",
        "",
        PODPIS_TIM,
      ].join("\n"),
    },
  },
  {
    key: "posta_1",
    label: "Nevyzdvihnutá zásielka — 1. upozornenie",
    description: "Prvý e-mail, keď zásielka dorazí na poštu a čaká na vyzdvihnutie.",
    ownPlaceholders: POSTA_PLACEHOLDERS,
    defaultText: {
      subject: "Vaša zásielka čaká na vyzdvihnutie | {{cislo_zasielky}}",
      body: postaBody(
        `vaša zásielka č. **{{cislo_zasielky}}** je uložená ${POSTA_MIESTO} a čaká na vyzdvihnutie.`,
        "{{#ak termin_vyzdvihnutia}}Prosím vyzdvihnite si ju do **{{termin_vyzdvihnutia}}**, aby nebola vrátená späť odosielateľovi.{{inak}}Prosím vyzdvihnite si ju čo najskôr, aby nebola vrátená späť odosielateľovi.{{/ak}}",
      ),
    },
  },
  {
    key: "posta_2",
    label: "Nevyzdvihnutá zásielka — 2. pripomienka",
    description: "Druhý e-mail, keď zásielka na pošte stále čaká.",
    ownPlaceholders: POSTA_PLACEHOLDERS,
    defaultText: {
      subject: "Pripomienka: zásielka stále čaká | {{cislo_zasielky}}",
      body: postaBody(
        `opätovne vás upozorňujeme, že vaša zásielka č. **{{cislo_zasielky}}** je stále uložená ${POSTA_MIESTO} a zatiaľ nebola vyzdvihnutá.`,
        "{{#ak termin_vyzdvihnutia}}Termín na vyzdvihnutie sa blíži: **{{termin_vyzdvihnutia}}**. Po tomto dátume bude zásielka vrátená.{{inak}}Prosím vyzdvihnite si ju čo najskôr. Zásielka bude čoskoro vrátená odosielateľovi.{{/ak}}",
      ),
    },
  },
  {
    key: "posta_3",
    label: "Nevyzdvihnutá zásielka — 3. posledné upozornenie",
    description: "Tretí e-mail — posledné upozornenie pred vrátením zásielky.",
    ownPlaceholders: POSTA_PLACEHOLDERS,
    defaultText: {
      subject: "Posledné upozornenie: zásielka bude vrátená | {{cislo_zasielky}}",
      body: postaBody(
        `toto je naše posledné upozornenie — vaša zásielka č. **{{cislo_zasielky}}** je stále ${POSTA_MIESTO}.`,
        "{{#ak termin_vyzdvihnutia}}Ak si ju nevyzdvihnete do **{{termin_vyzdvihnutia}}**, bude vrátená späť odosielateľovi.{{inak}}Ak si ju čoskoro nevyzdvihnete, bude vrátená späť odosielateľovi.{{/ak}}",
      ),
    },
  },
  {
    key: "posta_4",
    label: "Nevyzdvihnutá zásielka — posledná výzva",
    description: "Štvrtý a každý ďalší e-mail — zásielka sa v najbližších dňoch vracia.",
    ownPlaceholders: POSTA_PLACEHOLDERS,
    defaultText: {
      subject: "Posledná výzva: zásielka bude vrátená | {{cislo_zasielky}}",
      body: postaBody(
        `napriek opakovaným upozorneniam vaša zásielka č. **{{cislo_zasielky}}** je stále nevyzdvihnutá ${POSTA_MIESTO}.`,
        "Zásielka bude v najbližších dňoch vrátená späť. Ak ju stále chcete, prosím kontaktujte nás čo najskôr na {{kontakt_email}} alebo telefonicky.",
      ),
    },
  },
  {
    key: "order_reminder",
    label: "Pripomienka objednávky",
    description: "E-mail zákazníkovi, ktorého objednávka sa vybavuje dlhšie než obvykle.",
    ownPlaceholders: [MENO, CISLO_OBJEDNAVKY],
    defaultText: {
      subject: "📦 Stav vašej objednávky z Forestshop.sk",
      body: [
        "Dobrý deň, **{{meno_zakaznika}}**,",
        "",
        "Všimli sme si, že spracovanie vašej objednávky č. **{{cislo_objednavky}}** trvá o niečo dlhšie než obvykle. Chceme vás ubezpečiť, že situáciu aktívne sledujeme a riešime.",
        "",
        "Mierne zdržanie môže byť spôsobené dostupnosťou tovaru, dopĺňaním zásob alebo prepravnými okolnosťami. Rozumieme, že sa na svoju výbavu tešíte, a robíme všetko pre to, aby ste ju mali čo najskôr pri sebe.",
        "",
        "👉 V prípade potreby zmeny, alternatívy alebo potvrdenia z vašej strany vás budeme osobne kontaktovať v najbližšom čase.",
        "",
        "Ďakujeme vám za trpezlivosť a dôveru. Ak máte akékoľvek otázky, pokojne nás kontaktujte na {{kontakt_email}} alebo na telefónnom čísle {{kontakt_telefon}}.",
        "",
        PODPIS_TIM,
      ].join("\n"),
    },
  },
  {
    key: "supplier_order",
    label: "Objednávka dodávateľovi",
    description: "Hromadný zoznam položiek, ktorý sa posiela dodávateľovi. Tento e-mail je čisto textový.",
    ownPlaceholders: [
      { name: "dodavatel", label: "Názov dodávateľa", example: { kind: "text", text: "DODAVATEL-TEST-1" } },
      { name: "pocet_poloziek", label: "Počet položiek", example: { kind: "text", text: "2" } },
      { name: "slovo_poloziek", label: "Slovo „položka“ v správnom tvare", example: { kind: "text", text: "položky" } },
      {
        name: "zoznam_poloziek",
        label: "Zoznam objednávaných položiek",
        example: { kind: "list", items: [{ label: "4859/46 | kód 12345 | 46 | 2 ks" }, { label: "40287 | 1 ks" }] },
      },
    ],
    defaultText: {
      subject: "Objednávka — {{dodavatel}} ({{pocet_poloziek}} {{slovo_poloziek}})",
      // Prvý riadok tela ZÁMERNE opakuje predmet a za ním nasleduje JEDNO
      // zalomenie — presne tak, ako to appka posielala doteraz
      // (`[subject, ...lines].join("\n")`).
      body: "Objednávka — {{dodavatel}} ({{pocet_poloziek}} {{slovo_poloziek}})\n{{zoznam_poloziek}}",
    },
  },
  {
    key: "order_merge",
    label: "Zlúčenie objednávky",
    description: "E-mail zákazníkovi, keď sa jeho viaceré objednávky posielajú spolu ako jedna zásielka.",
    // issue 257: `zoznam_objednavok` je OBYČAJNÝ TEXT (nie `list`) — ide o
    // spojené čísla objednávok priamo vo vete ("vaše objednávky č. X a č. Y"),
    // `list` by šablónový engine vykreslil ako samostatný `<ul>` blok a
    // rozbil by plynulosť vety (`modules/orders/merge-mail.ts` skladá text).
    ownPlaceholders: [
      MENO,
      {
        name: "zoznam_objednavok",
        label: "Čísla zlučovaných objednávok (spojený text)",
        example: { kind: "text", text: "č. 20260123 a č. 20260124" },
      },
    ],
    defaultText: {
      subject: "Vaše objednávky spájame do jednej zásielky — Forestshop.sk",
      body: [
        "Dobrý deň, **{{meno_zakaznika}}**,",
        "",
        "radi by sme vás informovali, že vaše objednávky {{zoznam_objednavok}} spolu odosielame ako JEDNU zásielku — ušetríte tak na poštovnom aj na čakaní.",
        "",
        "Ak máte akékoľvek otázky, pokojne nás kontaktujte na {{kontakt_email}} alebo na telefónnom čísle {{kontakt_telefon}}.",
        "",
        PODPIS_TIM,
      ].join("\n"),
    },
  },
];

export const MAIL_TEMPLATE_KINDS: Readonly<Record<MailTemplateKey, MailTemplateKind>> = Object.fromEntries(
  KINDS.map((kind) => [kind.key, kind]),
) as Readonly<Record<MailTemplateKey, MailTemplateKind>>;

/** Všetky polia, ktoré daná šablóna smie použiť — vlastné plus spoločné. */
export function placeholdersFor(key: MailTemplateKey): readonly PlaceholderDef[] {
  return [...MAIL_TEMPLATE_KINDS[key].ownPlaceholders, ...GLOBAL_PLACEHOLDERS];
}

export function allowedPlaceholderNames(key: MailTemplateKey): ReadonlySet<string> {
  return new Set(placeholdersFor(key).map((p) => p.name));
}

/** Kontext zložený z ukážkových hodnôt — základ pre náhľad, ktorý sa prekryje
 * skutočnými dátami, ak sa nejaké nájdu (`samples.ts`). */
export function exampleContext(key: MailTemplateKey): Record<string, TemplateValue> {
  return Object.fromEntries(placeholdersFor(key).map((p) => [p.name, p.example]));
}
