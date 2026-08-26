// issue 500: rovnaký server-side vynútený „náhľad VŽDY pred odoslaním"
// mechanizmus ako `modules/nedostupne/preview-tokens.ts` /
// `modules/orders/merge-mail-preview-tokens.ts` (viď návrhový komentár na
// tickete + `.claude/rules/nedostupne.md`) — `/order-customer-contact/preview`
// vydá jednorazový token viazaný na presne `orderCode`, `.../send` ho musí
// priniesť späť a token sa SKONZUMUJE (zmaže) pri prvom pokuse o odoslanie, bez
// ohľadu na zhodu. Bez tohto by priame volanie API mohlo poslať e-mail
// zákazníkovi bez toho, aby ho čokoľvek niekedy zobrazilo — presne ten gap,
// ktorý `nedostupne`/`order-merge` zámerne zatvorili pred mergom. Rovnaký
// in-process `Map` vzor ako `login-rate-limit.ts` (jedna bežiaca inštancia
// appky, MVP rozsah — reštart appky token zruší, čo je v poriadku, obsluha si
// vie náhľad znova otvoriť).
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minút — rovnaký strop ako nedostupne/order-merge
const MAX_ENTRIES = 1_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PreviewTokenEntry {
  readonly orderCode: string;
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

/** Vydá nový jednorazový token pre presne túto objednávku (`externalOrderId`) —
 * volané `POST /api/order-customer-contact/preview`. */
export function issueCustomerContactPreviewToken(orderCode: string, now: Date): string {
  const nowMs = now.getTime();
  sweepExpired(nowMs);
  // Strop dosiahnutý → uvoľni miesto zmazaním najskôr vypršiavajúceho záznamu
  // (rovnaký zámer ako `merge-mail-preview-tokens.ts`).
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
  tokens.set(token, { orderCode, expiresAt: nowMs + TOKEN_TTL_MS });
  return token;
}

/** Skonzumuje (zmaže) token a vráti, či bol platný PRE PRESNE túto objednávku —
 * `POST /api/order-customer-contact/send` volá TOTO pred akýmkoľvek odoslaním.
 * Token sa maže VŽDY (aj pri nezhode) — jednorazový, nikdy sa nedá „vyskúšať"
 * opakovane. */
export function consumeCustomerContactPreviewToken(token: string, orderCode: string, now: Date): boolean {
  const entry = tokens.get(token);
  tokens.delete(token);
  if (entry === undefined) return false;
  if (entry.expiresAt <= now.getTime()) return false;
  return entry.orderCode === orderCode;
}
