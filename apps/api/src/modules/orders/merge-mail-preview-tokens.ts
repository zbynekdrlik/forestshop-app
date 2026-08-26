import { createSingleUsePreviewTokenStore } from "../single-use-preview-tokens.js";

// issue 257: rovnaký server-side vynútený "náhľad VŽDY pred odoslaním"
// mechanizmus ako `modules/nedostupne/preview-tokens.ts` (viď návrhový
// komentár na tickete + `.claude/rules/nedostupne.md`) — `/merge-mail/preview`
// vydá jednorazový token viazaný na presne (baseOrderId, zoradená množina
// vybraných orderId), `/merge-mail/send` ho musí priniesť späť a token sa
// SKONZUMUJE (zmaže) pri prvom pokuse o odoslanie, bez ohľadu na zhodu. Bez
// tohto by priame volanie API mohlo poslať e-mail zákazníkovi bez toho, aby
// ho čokoľvek niekedy zobrazilo.
//
// issue 505: jadro sa presunulo do zdieľaného
// `modules/single-use-preview-tokens.ts`; tento súbor je už len tenký wrapper,
// ktorý serializuje svoj (baseOrderId, selectionKey) kľúč a deleguje na vlastný
// store. Verejné signatúry sa nemenia.
const store = createSingleUsePreviewTokenStore();

/** Kanonický, poradie-nezávislý kľúč vybraných "ostatných" objednávok —
 * `/preview` aj `/send` ho počítajú z rovnakého poľa `otherOrderIds`, takže
 * poradie checkboxov v UI nikdy nerozhodne o (ne)zhode tokenu. */
export function mergeSelectionKey(otherOrderIds: readonly string[]): string {
  return [...otherOrderIds].sort().join(",");
}

// Injektívny reťazcový kľúč z (základná objednávka, kanonický výber).
// `JSON.stringify` zaručuje, že sa (baseOrderId, selectionKey) nikdy nezlejú
// nejednoznačne — porovnanie je ekvivalentné pôvodnému porovnaniu po poliach.
function keyOf(baseOrderId: string, otherOrderIds: readonly string[]): string {
  return JSON.stringify([baseOrderId, mergeSelectionKey(otherOrderIds)]);
}

/** Vydá nový jednorazový token pre presne túto (základná objednávka, výber) —
 * volané `POST /api/orders/:id/merge-mail/preview`. */
export function issueMergePreviewToken(baseOrderId: string, otherOrderIds: readonly string[], now: Date): string {
  return store.issue(keyOf(baseOrderId, otherOrderIds), now);
}

/** Skonzumuje (zmaže) token a vráti, či bol platný PRE PRESNE tento (základná
 * objednávka, výber) — `POST /api/orders/:id/merge-mail/send` volá TOTO pred
 * akýmkoľvek odoslaním. Token sa maže VŽDY (aj pri nezhode) — jednorazový. */
export function consumeMergePreviewToken(
  token: string,
  baseOrderId: string,
  otherOrderIds: readonly string[],
  now: Date,
): boolean {
  return store.consume(token, keyOf(baseOrderId, otherOrderIds), now);
}
