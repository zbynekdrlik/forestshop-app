import { normalizeStatusName } from "./parser.js";

// issue 290: "Eshop → Výmena tovaru / Vrátený tovar / Reklamácie" — TRI
// nové READ-ONLY stránky nad `order.status_name` (Výmena/Vrátený tovar) a
// nad appkiným vlastným `order.claim_marked_at` (Reklamácie, `state.ts`
// vedľa tohto súboru). Priradenie stavov je OVERENÉ NAŽIVO na produkcii
// (issue 290, komentár na tickete, 2026-08-07), nie odhadnuté zo starej
// appky — rovnaká disciplína ako `return-status.ts`'s zoznam vyššie v tomto
// module, ale ÚPLNE SAMOSTATNÝ menný priestor: tieto tri stránky nikdy
// nečítajú `return-status.ts`'s mapy priamo (mali by iný, neúmyselne
// prepojený rozsah, keby sa niekedy zmenil dôvod #297's rozdelenia
// aktívne/hotové), len ROVNAKÚ funkciu (`normalizeStatusName`) na
// porovnanie, presne ako `open-statuses.ts`.
const EXCHANGE_STATUS = normalizeStatusName("Výmena tovaru");
const RETURNED_GOODS_STATUS = normalizeStatusName("Vratený tovar");

/** `true`, keď objednávka patrí na stránku "Výmena tovaru" — presne AKTÍVny
 * stav "Výmena tovaru" (issue 514, Štěpán: sekcia má ukazovať len aktívne
 * výmeny na vybavenie). Vybavená výmena ("Vybavená výmena") sa tu už
 * NEzobrazuje. Issue 290 pôvodne cielilo "Vybavená výmena", lebo vtedy
 * (7.8.2026) produkcia nemala ani jednu objednávku v stave "Výmena tovaru";
 * realita sa medzitým zmenila (živo overené na tikete #514: 1× "Výmena
 * tovaru", 8× "Vybavená výmena"). */
export function isExchangeOrderStatus(statusName: string): boolean {
  return normalizeStatusName(statusName) === EXCHANGE_STATUS;
}

/** `true`, keď objednávka patrí na stránku "Vrátený tovar" — presne AKTÍVny
 * stav "Vratený tovar" (issue 516, Štěpán: sekcia má ukazovať len aktívne
 * vrátenia na vybavenie, „nie vybavený Dobropis"). Hotový "Vybavený
 * Dobropis" sa tu už NEzobrazuje. Issue 290 pôvodne priradilo OBA stavy;
 * #516 to zúžilo na aktívny stav rovnakým vzorom, akým #514 zúžilo "Výmena
 * tovaru" (z hotovej "Vybavená výmena" na aktívnu "Výmena tovaru"). Priradenie
 * živo overené na prod DB (tiket #516: 3× "Vratený tovar", 5× "Vybavený
 * Dobropis"). "Vybavený Dobropis" ostáva HOTOVÝM vrátkovým stavom výhradne v
 * `return-status.ts` (auto-zatvára kartu pri importe) — samostatný menný
 * priestor Upozornení, nesúvisí s tým, čo táto sekcia zobrazuje. */
export function isReturnedOrderStatus(statusName: string): boolean {
  return normalizeStatusName(statusName) === RETURNED_GOODS_STATUS;
}
