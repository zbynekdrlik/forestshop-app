import { createSingleUsePreviewTokenStore } from "../single-use-preview-tokens.js";

// issue 500: rovnaký server-side vynútený „náhľad VŽDY pred odoslaním"
// mechanizmus ako `modules/nedostupne/preview-tokens.ts` /
// `modules/orders/merge-mail-preview-tokens.ts` (viď návrhový komentár na
// tickete + `.claude/rules/nedostupne.md`) — `/order-customer-contact/preview`
// vydá jednorazový token viazaný na presne `orderCode`, `.../send` ho musí
// priniesť späť a token sa SKONZUMUJE (zmaže) pri prvom pokuse o odoslanie, bez
// ohľadu na zhodu. Bez tohto by priame volanie API mohlo poslať e-mail
// zákazníkovi bez toho, aby ho čokoľvek niekedy zobrazilo.
//
// issue 505: jadro sa presunulo do zdieľaného
// `modules/single-use-preview-tokens.ts`; tento súbor je už len tenký wrapper.
// Kľúč je jediné pole `orderCode` (e-mail zákazníkovi je per-objednávka), takže
// sa použije priamo ako reťazcový kľúč. Verejné signatúry sa nemenia.
const store = createSingleUsePreviewTokenStore();

/** Vydá nový jednorazový token pre presne túto objednávku (`externalOrderId`) —
 * volané `POST /api/order-customer-contact/preview`. */
export function issueCustomerContactPreviewToken(orderCode: string, now: Date): string {
  return store.issue(orderCode, now);
}

/** Skonzumuje (zmaže) token a vráti, či bol platný PRE PRESNE túto objednávku —
 * `POST /api/order-customer-contact/send` volá TOTO pred akýmkoľvek odoslaním.
 * Token sa maže VŽDY (aj pri nezhode) — jednorazový, nikdy sa nedá „vyskúšať"
 * opakovane. */
export function consumeCustomerContactPreviewToken(token: string, orderCode: string, now: Date): boolean {
  return store.consume(token, orderCode, now);
}
