import type { NedostupneEmailType } from "./constants.js";

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
// zhoduje. Rovnaký in-process Map vzor ako `login-rate-limit.ts` (jedna
// bežiaca inštancia appky, MVP rozsah — reštart appky token zruší, čo je
// v poriadku, obsluha si vie náhľad znova otvoriť).
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minút — dosť na to, aby si obsluha náhľad prečítala, nie navždy platné
const MAX_ENTRIES = 1_000; // strop proti neobmedzenému rastu (opakované náhľady bez odoslania)
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PreviewTokenEntry {
  readonly orderCode: string;
  readonly variantCode: string;
  readonly emailType: NedostupneEmailType;
  readonly expiresAt: number;
}

const tokens = new Map<string, PreviewTokenEntry>();
let lastSweepAtMs = 0;

function sweepExpired(nowMs: number): void {
  if (nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS) return;
  lastSweepAtMs = nowMs;
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= nowMs) tokens.delete(token);
  }
}

/** Vydá nový jednorazový token pre presne tento (objednávka, variant, typ) —
 * volané `POST /api/nedostupne/preview`. */
export function issuePreviewToken(orderCode: string, variantCode: string, emailType: NedostupneEmailType, now: Date): string {
  const nowMs = now.getTime();
  sweepExpired(nowMs);
  // Strop dosiahnutý → uvoľni miesto zmazaním najskôr vypršiavajúceho záznamu
  // (rovnaký zámer ako `login-rate-limit.ts`'s dávkové mazanie, len po
  // jednom — tokeny sú oveľa menej časté než prihlasovacie pokusy).
  if (tokens.size >= MAX_ENTRIES) {
    let oldestToken: string | undefined;
    let oldestExpiresAt = Infinity;
    for (const [token, entry] of tokens) {
      if (entry.expiresAt < oldestExpiresAt) {
        oldestExpiresAt = entry.expiresAt;
        oldestToken = token;
      }
    }
    if (oldestToken !== undefined) tokens.delete(oldestToken);
  }
  const token = crypto.randomUUID();
  tokens.set(token, { orderCode, variantCode, emailType, expiresAt: nowMs + TOKEN_TTL_MS });
  return token;
}

/** Skonzumuje (zmaže) token a vráti, či bol platný PRE PRESNE tento (objednávka,
 * variant, typ) — `POST /api/nedostupne/send` volá TOTO pred akýmkoľvek
 * odoslaním. Token sa maže VŽDY (aj pri nezhode) — jednorazový, nikdy sa
 * nedá "vyskúšať" opakovane. */
export function consumePreviewToken(token: string, orderCode: string, variantCode: string, emailType: NedostupneEmailType, now: Date): boolean {
  const entry = tokens.get(token);
  tokens.delete(token);
  if (entry === undefined) return false;
  if (entry.expiresAt <= now.getTime()) return false;
  return entry.orderCode === orderCode && entry.variantCode === variantCode && entry.emailType === emailType;
}
