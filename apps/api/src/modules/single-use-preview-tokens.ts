// issue 505: zdieľané jadro troch pôvodne bajt-na-bajt identických modulov
// jednorazových preview-tokenov — `nedostupne/preview-tokens.ts`,
// `orders/merge-mail-preview-tokens.ts` a `orders/customer-contact-preview-tokens.ts`.
//
// Server-side vynútený „náhľad VŽDY pred odoslaním": `/preview` vydá jednorazový
// token viazaný na presný KĽÚČ, `/send` ho musí priniesť späť a token sa
// SKONZUMUJE (zmaže) pri prvom pokuse o odoslanie, bez ohľadu na zhodu. Bez tohto
// by priame volanie API (skript, iný klient, budúca frontendová regresia) mohlo
// poslať e-mail bez toho, aby ho čokoľvek niekedy zobrazilo — presne ten gap,
// ktorý `nedostupne` zámerne zatvoril pred mergom PR #182. Rovnaký in-process
// `Map` vzor ako `http/login-rate-limit.ts` (jedna bežiaca inštancia appky, MVP
// rozsah — reštart appky token zruší, čo je v poriadku, obsluha si vie náhľad
// znova otvoriť).
//
// Tvar kľúča je vecou volajúceho wrappera (ĽUBOVOĽNÝ reťazec) — každá z troch
// features si serializuje svoje polia do injektívneho reťazca. Každý wrapper má
// VLASTNÝ nezávislý store (samostatná Map + strop), aby sa `MAX_ENTRIES`
// eviction nezdieľal naprieč features — správanie ostáva presne také, ako keď
// išlo o tri oddelené moduly.
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minút — dosť na to, aby si obsluha náhľad prečítala, nie navždy platné
const MAX_ENTRIES = 1_000; // strop proti neobmedzenému rastu (opakované náhľady bez odoslania)
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PreviewTokenEntry {
  readonly key: string;
  readonly expiresAt: number;
}

export interface SingleUsePreviewTokenStore {
  /** Vydá nový jednorazový token viazaný na presne tento `key` — volané z `/preview`. */
  issue(key: string, now: Date): string;
  /** Skonzumuje (zmaže) token a vráti, či bol platný PRE PRESNE tento `key` —
   * volané z `/send` pred akýmkoľvek odoslaním. Token sa maže VŽDY (aj pri
   * nezhode) — jednorazový, nikdy sa nedá „vyskúšať" opakovane. */
  consume(token: string, key: string, now: Date): boolean;
}

/** Vytvorí nezávislý in-process store jednorazových preview-tokenov. Každý
 * wrapper (nedostupne / order-merge / customer-contact) si drží jednu inštanciu
 * na úrovni modulu — presne ako pôvodné tri oddelené moduly. */
export function createSingleUsePreviewTokenStore(): SingleUsePreviewTokenStore {
  const tokens = new Map<string, PreviewTokenEntry>();
  let lastSweepAtMs = 0;

  function sweepExpired(nowMs: number): void {
    if (nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS) return;
    lastSweepAtMs = nowMs;
    for (const [token, entry] of tokens) {
      if (entry.expiresAt <= nowMs) tokens.delete(token);
    }
  }

  function issue(key: string, now: Date): string {
    const nowMs = now.getTime();
    sweepExpired(nowMs);
    // Strop dosiahnutý → uvoľni miesto zmazaním najskôr vypršiavajúceho záznamu
    // (rovnaký zámer ako `login-rate-limit.ts`'s dávkové mazanie, len po jednom —
    // tokeny sú oveľa menej časté než prihlasovacie pokusy).
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
    tokens.set(token, { key, expiresAt: nowMs + TOKEN_TTL_MS });
    return token;
  }

  function consume(token: string, key: string, now: Date): boolean {
    const entry = tokens.get(token);
    tokens.delete(token);
    if (entry === undefined) return false;
    if (entry.expiresAt <= now.getTime()) return false;
    return entry.key === key;
  }

  return { issue, consume };
}
