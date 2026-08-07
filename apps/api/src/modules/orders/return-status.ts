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
//
// issue 297 (majiteľov šéf, cez Discord): "Vybavená výmena"/"Vybavený
// Dobropis" sú HOTOVÉ stavy — majiteľ NEPOTREBUJE upozornenie na prácu, ktorú
// niekto už spravil. Zoznam sa preto rozdeľuje na DVE nezávislé mapy:
// AKTÍVNE (`classifyReturnStatus`, karta sa ZAKLADÁ/OBNOVUJE) a HOTOVÉ
// (`classifyFinishedReturnStatus`, existujúca otvorená karta sa naopak
// AUTOMATICKY ZATVÁRA — `ingest.ts`). "Vratený tovar" ostáva zatiaľ v
// AKTÍVNYCH — majiteľ ešte nepovedal, ako presne chce upozornenie na vrátené
// zásielky riešiť (jeho druhý bod v tom istom vlákne, mimo rozsahu #297).
const ACTIVE_RETURN_STATUS_LABELS: ReadonlyMap<string, string> = new Map([[normalizeStatusName("Vratený tovar"), "vrátený tovar"]]);

const FINISHED_RETURN_STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  [normalizeStatusName("Vybavená výmena"), "vybavená výmena"],
  [normalizeStatusName("Vybavený Dobropis"), "vybavený dobropis"],
]);

/** `null`, keď stav objednávky nie je AKTÍVNY vrátkový stav (karta sa
 * zakladá/obnovuje) — inak ľudský štítok použiteľný priamo v titulku karty. */
export function classifyReturnStatus(statusName: string): string | null {
  return ACTIVE_RETURN_STATUS_LABELS.get(normalizeStatusName(statusName)) ?? null;
}

/** `null`, keď stav objednávky nie je HOTOVÝ vrátkový stav — inak ľudský
 * štítok (dnes nepoužitý v titulku, len na symetriu s `classifyReturnStatus`
 * pre budúcich volajúcich). Existujúca otvorená karta pre tento `dedupKey` sa
 * pri tomto stave AUTOMATICKY ZATVÁRA (`ingest.ts`), nikdy nezakladá nová. */
export function classifyFinishedReturnStatus(statusName: string): string | null {
  return FINISHED_RETURN_STATUS_LABELS.get(normalizeStatusName(statusName)) ?? null;
}

/** Stabilný kľúč proti duplicitám — JEDNA karta NA OBJEDNÁVKU (nie na
 * konkrétny pod-stav): prechod "Vratený tovar" → "Vybavený Dobropis" je
 * koncepčne TÁ ISTÁ udalosť pre TÚ istú objednávku, rovnaký princíp ako
 * `posta-uncollected/logic.ts`'s `postaUpozornenieDedupKey` (kľúč na
 * zásielku, nie na jej okamžitú klasifikáciu). */
export function returnUpozornenieDedupKey(externalOrderId: string): string {
  return `vratenie:${externalOrderId}`;
}
