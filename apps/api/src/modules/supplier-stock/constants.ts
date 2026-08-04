// issue 212: "Dodávateľský sklad" — scraper dostupnosti u dodávateľa.
// Majiteľ 3. 8. 2026 výslovne ZAMIETOL AI fallback (stará appka posielala
// nečitateľné stránky do OpenAI): čo sa nedá prečítať strojovo, ostáva
// `unknown` a ukáže sa v zozname nečitateľných stránok.

export const SUPPLIER_STOCK_JOB_NAME = "supplier-stock";

// Vlastný advisory zámok — job má manuálny trigger ("Spustiť teraz") na TÚ
// ISTÚ prácu ako nočný beh, presne ako `postaUncollectedJob`
// (`.claude/rules/scheduler.md`). Session-scoped `pg_advisory_lock` na
// vyhradenom pripojení, nie xact-scoped: beh robí stovky sekvenčných HTTP
// volaní a držať kvôli nim otvorenú transakciu by zbytočne blokovalo pool.
export const SUPPLIER_STOCK_RUN_LOCK_KEY = 787_878_007;

// Linka s ÚSPEŠNOU kontrolou mladšou než toto sa znova nesťahuje. 20 h (nie
// 24) zámerne: pri dennom behu by presne 24 h občas o pár minút nevyšlo a
// linka by sa preskočila na celý deň.
export const MAX_AGE_HOURS = 20;

// Slušnosť k dodávateľom — beh je sériový, toto je minimálna pauza medzi
// dvoma požiadavkami na TÚ ISTÚ doménu. Reálne dáta: 969 z 1 210 riadkov
// je jedna doména (`huntingshop.eu`), takže bez tejto pauzy by scraper
// vyzeral ako útok.
export const PER_HOST_DELAY_MS = 1_500;

export const REQUEST_TIMEOUT_MS = 15_000;

// Strop na veľkosť stiahnutej stránky — číta sa po častiach a nad týmto sa
// spojenie prerušie (rovnaká úvaha ako `catalog/fetcher.ts`'s `readBounded`:
// strop musí platiť POČAS čítania, nie až po zbufferovaní celého tela).
//
// Zvýšené z pôvodných 2 000 000 (issue 224, naživo overené na produkcii po
// nasadení): `shop.lasting.eu`'s BONY čiapka má CELÚ stránku 2 180 285 bajtov
// — takmer výhradne z opakovaného whitespace v PrestaShop šablóne skupiny
// "Odstín" (po zošmiznutí opakovaných medzier/tabov klesne skutočný obsah na
// ~168 000 bajtov). Veľkostný zoznam (`parseSizeAvailability`, issue 224) je
// na stránke AŽ ZA touto skupinou, takže pôvodný 2 MB strop ho odrezával —
// L/XL veľkosť (presne tá, ktorú má ticket dokázať ako `unavailable`)
// zmizla úplne, kým JSON-LD (blízko začiatku `<head>`) strop nikdy
// nezasiahol. Nový strop necháva rezervu nad zmeranou veľkosťou tejto
// konkrétnej stránky bez neobmedzeného rastu.
export const MAX_PAGE_BYTES = 5_000_000;

// Vlastný User-Agent s kontaktom — dodávateľ musí vedieť, kto mu chodí na
// stránku a komu napísať, keby mu to prekážalo.
export const USER_AGENT =
  "ForestshopBot/1.0 (kontrola dostupnosti; +https://forestshop.sk)";

// Domény s pravidlom pre voľný text sú definované priamo v `parse.ts`
// (`TEXT_AVAILABILITY_RULES`) — každá nesie VÝREZ (ktorá oblasť stránky patrí
// TOMUTO produktu), nie len meno domény. Mimo tohto zoznamu sa voľnému textu
// NEDÔVERUJE vôbec a výsledok je `unknown` — radšej nič než dohad, ktorý by
// zapol produkt (issue 223: `wetland.sk`/`trigona.sk` boli predtým v tomto
// poli ako celostránkové domény bez overeného výrezu; kým sa pre ne nenájde
// a neoverí vlastný výrez, ostávajú bez textovej úrovne).
