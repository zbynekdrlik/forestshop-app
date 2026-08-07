import { normalizeStatusName } from "./parser.js";

// issue 301: tretie automatické Upozornenie — objednávka, ktorá dlho visí v
// NEVYBAVENOM stave (šéf: "objednávky, ktoré je potrebné riešiť"). Naživo
// overené na produkcii (7. 8. 2026): 31 objednávok v stave "Vybavuje sa"
// (najstaršia od 30. 4. 2026), 3 v stave "Nevybavená" (najstaršia od
// 7. 5. 2026) — presne TIETO dva stavy, žiadny ďalší (rozšírenie zoznamu
// vyžaduje ROVNAKÉ živé overenie proti produkčnej DB ako `return-status.ts`,
// nikdy odhad).
//
// ZÁMERNE NEZDIEĽANÉ s `open-statuses.ts`'s admin-nastaviteľným
// `order_open_status` zoznamom (ten rozhoduje, čo appka ukáže na "Na
// objednanie" a šéf ho sám edituje) — "visí príliš dlho" je NEZÁVISLÝ,
// fixný pojem: aj keby šéf zajtra pridal/odobral stav zo zoznamu "Na
// objednanie", toto upozornenie musí zostať naviazané na tie ISTÉ dva stavy,
// ktoré naživo videl v dátach. Rovnaký princíp ako `return-status.ts`'s
// vlastný nezávislý zoznam vrátkových stavov.
const UNFINISHED_ORDER_STATUS_NAMES: ReadonlySet<string> = new Set([
  normalizeStatusName("Vybavuje sa"),
  normalizeStatusName("Nevybavená"),
]);

// Prečo 14 dní: appka už má KRATŠÍ vekový prah pre PRÍBUZNÚ, ale INÚ vec —
// `order-reminder/constants.ts`'s `MIN_DAYS = 4` rozhoduje, kedy pripomenúť
// ZÁKAZNÍKOVI jeho vlastnú objednávku (rýchla, zákaznícky orientovaná
// akcia). Toto upozornenie je opačné — má upozorniť ŠÉFA, že objednávka sa v
// appke/dodávateľskom procese niekde zasekla, nie že zákazník ešte čaká pár
// dní na bežné vybavenie. Bežné dodávateľské vybavenie (objednanie u
// dodávateľa, doručenie, zabalenie) trvá v tomto obchode rutinne dni až
// nižšie jednotky týždňov — 14 dní (dva týždne) dáva tomuto bežnému postupu
// priestor bez toho, aby appka spamovala kartami za KAŽDÚ objednávku, čo je
// len pár dní stará, a zároveň chytí objednávky, čo naozaj "zabudnuté visia"
// (naživo overené najstaršie prípady sú v desiatkach dní, nie v jednotkách).
// Prvá verzia — šéf ho podľa ticketu doladí po tom, čo kartu uvidí naživo.
export const ORDER_STUCK_THRESHOLD_DAYS = 14;

/** `true`, keď je stav objednávky jeden z NEVYBAVENÝCH stavov, za ktoré
 * appka počíta dni "visenia" (`daysStuck` nižšie). Normalizované rovnakou
 * funkciou, akou appka ukladá `order.status_name` (`parser.ts`), presne ako
 * `return-status.ts`. */
export function isUnfinishedOrderStatus(statusName: string): boolean {
  return UNFINISHED_ORDER_STATUS_NAMES.has(normalizeStatusName(statusName));
}

/** Celé dni od `placedAt` po `now` — nikdy záporné (rovnaký zámer ako
 * `order-reminder/logic.ts`'s `daysOpen`; zámerne DUPLIKOVANÁ jednoriadková
 * formula namiesto importu odtiaľ — import by vytvoril závislosť "orders"
 * modulu na satelitnom `order-reminder` module, opačný smer než architektúra
 * tohto repa, `.claude/rules/mvp-philosophy.md`). */
export function daysStuck(placedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - placedAt.getTime()) / 86_400_000));
}

/** Stabilný dedup kľúč NA OBJEDNÁVKU — samostatný menný priestor od
 * `posta:`/`posta-vratena:`/`vratenie:` (`.claude/rules/upozornenia.md`), aby
 * TÁ ISTÁ objednávka mohla mať súčasne otvorenú kartu "visí" AJ kartu
 * "vrátenie" bez kolízie na čiastočnom unique indexe. */
export function stuckOrderUpozornenieDedupKey(externalOrderId: string): string {
  return `objednavka-visi:${externalOrderId}`;
}
