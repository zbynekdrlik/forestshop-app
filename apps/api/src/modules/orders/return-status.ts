import { normalizeStatusName } from "./parser.js";

// issue 269: druhý automatický zdroj pre nástenku Upozornenia (#267) —
// objednávka, ktorá prešla do vrátkového/výmenného/dobropisového stavu.
// Presný zoznam OVERENÝ ŽIVO na produkčnej DB (2026-08-05, `.claude/rules/
// upozornenia.md`'s validačný komentár na tickete), nie odhadnutý zo starej
// appky — zoznam sa NESMIE rozšíriť "od oka", nový vrátkový stav treba znova
// overiť proti reálnym dátam predtým, než sa sem pridá. Kľúč mapy je
// NORMALIZOVANÝ (`normalizeStatusName`, rovnaká funkcia, akú `ingest.ts`
// používa na uloženie `order.status_name`) — porovnanie beží v rovnakej
// forme na oboch stranách, presne ako `open-statuses.ts`.
const RETURN_STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  [normalizeStatusName("Vratený tovar"), "vrátený tovar"],
  [normalizeStatusName("Vybavená výmena"), "vybavená výmena"],
  [normalizeStatusName("Vybavený Dobropis"), "vybavený dobropis"],
]);

/** `null`, keď stav objednávky nie je žiadny zo živo overených vrátkových
 * stavov — inak ľudský štítok použiteľný priamo v titulku karty. */
export function classifyReturnStatus(statusName: string): string | null {
  return RETURN_STATUS_LABELS.get(normalizeStatusName(statusName)) ?? null;
}

/** Stabilný kľúč proti duplicitám — JEDNA karta NA OBJEDNÁVKU (nie na
 * konkrétny pod-stav): prechod "Vratený tovar" → "Vybavený Dobropis" je
 * koncepčne TÁ ISTÁ udalosť pre TÚ istú objednávku, rovnaký princíp ako
 * `posta-uncollected/logic.ts`'s `postaUpozornenieDedupKey` (kľúč na
 * zásielku, nie na jej okamžitú klasifikáciu). */
export function returnUpozornenieDedupKey(externalOrderId: string): string {
  return `vratenie:${externalOrderId}`;
}
