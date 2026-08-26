import type { NedostupneEmailType } from "./constants.js";
import { createSingleUsePreviewTokenStore } from "../single-use-preview-tokens.js";

// issue 176 (code review pred mergom, PR #182): ticketova podmienka "e-mail
// sa NIKDY nesmie odoslať automaticky, len po potvrdení náhľadu človekom" bola
// pôvodne vynútená LEN na strane frontendu (React komponent volá `/preview`
// pred zobrazením tlačidla "Odoslať") — server samotný `/send` nič
// nekontroloval, takže priamé volanie API (skript, iný klient, budúca
// frontendová regresia) mohlo poslať e-mail BEZ toho, aby ho čokoľvek
// niekedy zobrazilo. Tento modul vynucuje náhľad NA STRANE SERVERA:
// `/preview` vydá jednorazový token viazaný na presne (orderCode,
// variantCode, emailType), `/send` ho musí priniesť späť a token sa
// SKONZUMUJE (zmaže) pri prvom pokuse o odoslanie — bez ohľadu na to, či sa
// zhoduje.
//
// issue 505: jadro (Map, TTL, MAX_ENTRIES eviction, sweep, issue/consume) sa
// presunulo do zdieľaného `modules/single-use-preview-tokens.ts`; tento súbor
// je už len tenký wrapper, ktorý serializuje svoj (orderCode, variantCode,
// emailType) kľúč a deleguje na vlastný store. Verejné signatúry sa nemenia.
const store = createSingleUsePreviewTokenStore();

// Injektívny reťazcový kľúč z (objednávka, variant, typ). `JSON.stringify`
// (nie join s oddeľovačom) zaručuje, že dve rôzne trojice nikdy nedajú rovnaký
// reťazec — porovnanie kľúča je tak ekvivalentné pôvodnému porovnaniu po poliach.
function keyOf(orderCode: string, variantCode: string, emailType: NedostupneEmailType): string {
  return JSON.stringify([orderCode, variantCode, emailType]);
}

/** Vydá nový jednorazový token pre presne tento (objednávka, variant, typ) —
 * volané `POST /api/nedostupne/preview`. */
export function issuePreviewToken(orderCode: string, variantCode: string, emailType: NedostupneEmailType, now: Date): string {
  return store.issue(keyOf(orderCode, variantCode, emailType), now);
}

/** Skonzumuje (zmaže) token a vráti, či bol platný PRE PRESNE tento (objednávka,
 * variant, typ) — `POST /api/nedostupne/send` volá TOTO pred akýmkoľvek
 * odoslaním. Token sa maže VŽDY (aj pri nezhode) — jednorazový, nikdy sa nedá
 * "vyskúšať" opakovane. */
export function consumePreviewToken(token: string, orderCode: string, variantCode: string, emailType: NedostupneEmailType, now: Date): boolean {
  return store.consume(token, keyOf(orderCode, variantCode, emailType), now);
}
