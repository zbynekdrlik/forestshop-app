// issue 257: rovnaký server-side vynútený "náhľad VŽDY pred odoslaním"
// mechanizmus ako `modules/nedostupne/preview-tokens.ts` (viď návrhový
// komentár na tickete + `.claude/rules/nedostupne.md`) — `/merge-mail/preview`
// vydá jednorazový token viazaný na presne (baseOrderId, zoradená množina
// vybraných orderId), `/merge-mail/send` ho musí priniesť späť a token sa
// SKONZUMUJE (zmaže) pri prvom pokuse o odoslanie, bez ohľadu na zhodu. Bez
// tohto by priame volanie API mohlo poslať e-mail zákazníkovi bez toho, aby
// ho čokoľvek niekedy zobrazilo — presne ten gap, ktorý `nedostupne` opravil
// pred mergom PR #182 (dôvod, prečo sa tu znovu zavádza TÁ ISTÁ obrana,
// nikdy staršia slabšia konvencia `orders/mail.ts`'s dodávateľského náhľadu).
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minút — rovnaký strop ako nedostupne
const MAX_ENTRIES = 1_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PreviewTokenEntry {
  readonly baseOrderId: string;
  readonly selectionKey: string;
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

/** Kanonický, poradie-nezávislý kľúč vybraných "ostatných" objednávok —
 * `/preview` aj `/send` ho počítajú z rovnakého poľa `otherOrderIds`, takže
 * poradie checkboxov v UI nikdy nerozhodne o (ne)zhode tokenu. */
export function mergeSelectionKey(otherOrderIds: readonly string[]): string {
  return [...otherOrderIds].sort().join(",");
}

/** Vydá nový jednorazový token pre presne túto (základná objednávka, výber) —
 * volané `POST /api/orders/:id/merge-mail/preview`. */
export function issueMergePreviewToken(baseOrderId: string, otherOrderIds: readonly string[], now: Date): string {
  const nowMs = now.getTime();
  sweepExpired(nowMs);
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
  tokens.set(token, { baseOrderId, selectionKey: mergeSelectionKey(otherOrderIds), expiresAt: nowMs + TOKEN_TTL_MS });
  return token;
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
  const entry = tokens.get(token);
  tokens.delete(token);
  if (entry === undefined) return false;
  if (entry.expiresAt <= now.getTime()) return false;
  return entry.baseOrderId === baseOrderId && entry.selectionKey === mergeSelectionKey(otherOrderIds);
}
