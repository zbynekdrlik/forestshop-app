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
const EXCHANGE_STATUS = normalizeStatusName("Vybavená výmena");
const RETURNED_GOODS_STATUS = normalizeStatusName("Vratený tovar");
const RETURNED_CREDIT_STATUS = normalizeStatusName("Vybavený Dobropis");

/** `true`, keď objednávka patrí na stránku "Výmena tovaru" — presne stav
 * "Vybavená výmena" (jediný, čo majiteľ na produkcii reálne má; "Výmena
 * tovaru" — rozpracovaný stav — dnes nemá priradenú žiadnu objednávku,
 * rozhodnuté na tickete). */
export function isExchangeOrderStatus(statusName: string): boolean {
  return normalizeStatusName(statusName) === EXCHANGE_STATUS;
}

/** `true`, keď objednávka patrí na stránku "Vrátený tovar" — "Vratený
 * tovar" (rozpracované) ALEBO "Vybavený Dobropis" (jeho hotová podoba,
 * rozhodnuté na tickete). */
export function isReturnedOrderStatus(statusName: string): boolean {
  const normalized = normalizeStatusName(statusName);
  return normalized === RETURNED_GOODS_STATUS || normalized === RETURNED_CREDIT_STATUS;
}
