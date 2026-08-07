import { and, eq, isNull } from "drizzle-orm";
import { upozornenie } from "../../db/schema.js";
import { buildShoptetAdminOrderUrl } from "./queries.js";
import { daysStuck, isUnfinishedOrderStatus, ORDER_STUCK_THRESHOLD_DAYS, stuckOrderUpozornenieDedupKey } from "./stuck-status.js";
import { autoResolveByDedupKey, upsertUpozornenie, type UpozornenieExecutor } from "../upozornenia/service.js";

// issue 301: štvrtý automatický zdroj pre nástenku Upozornenia (#267) —
// objednávka, ktorá dlho visí v NEVYBAVENOM stave (`stuck-status.ts`), dostane/
// obnoví kartu; objednávka, ktorá sa medzičasom posunula do VYBAVENÉHO stavu,
// existujúcu otvorenú kartu AUTOMATICKY ZATVORÍ (rovnaký princíp ako #268's
// doručená zásielka a #297's HOTOVÝ vrátkový stav). `dedupKey` je NA
// OBJEDNÁVKU (`objednavka-visi:<externalOrderId>`) — vlastný menný priestor,
// aby súčasne mohla existovať aj NEZÁVISLÁ karta "vratenie" pre tú istú
// objednávku bez kolízie na čiastočnom unique indexe.
//
// Na rozdiel od `return-upozornenia.ts`'s `vratenie` (KONEČNÁ kategória —
// vybavené sa NIKDY znova neohlási) je "visí" kategória ZNOVA-OHLÁSITEĽNÁ,
// rovnaká rodina ako #268's zásielka: ak sa objednávka niekedy vráti späť do
// nevybaveného stavu a znova visí dosť dlho, má dostať NOVÉ upozornenie —
// preto tu NIE JE potrebný žiadny `.for("update")` "je už KONEČNE vybavené"
// pre-check, len jednoduchý upsert/auto-resolve pár (`.claude/rules/
// upozornenia.md`'s poučenie "rozhodni sa VOPRED, do ktorej z dvoch
// kategórií patrí").
//
// Vyčlenené do VLASTNÉHO súboru presne z rovnakého dôvodu ako
// `return-upozornenia.ts` (eslint `max-lines: 400`, `.claude/rules/
// testing.md`) — volá sa TESNE PRED commitom tej istej transakcie, spolu s
// `applyReturnUpozornenia`.
export interface ApplyStuckUpozorneniaOptions {
  readonly tx: UpozornenieExecutor;
  readonly orderInfo: ReadonlyMap<string, { readonly customerName: string; readonly statusName: string; readonly placedAt: Date }>;
  readonly orderIdsByCode: ReadonlyMap<string, number>;
  readonly adminBaseUrl: string;
  readonly now: Date;
}

export interface ApplyStuckUpozorneniaResult {
  readonly stuckOrderCount: number;
  readonly autoResolvedStuckOrderCount: number;
}

export async function applyStuckUpozornenia(options: ApplyStuckUpozorneniaOptions): Promise<ApplyStuckUpozorneniaResult> {
  const { tx, orderInfo, orderIdsByCode, adminBaseUrl, now } = options;

  // Dávkovo prečítané VOPRED (rovnaká disciplína ako `return-upozornenia.ts`'s
  // pre-check nižšie v tom istom module, len iný dôvod): väčšina objednávok
  // v okne NIKDY nedostala kartu "visí" (len tie, čo naozaj prekročili prah),
  // takže auto-resolve by inak musel bežať ako no-op UPDATE pre KAŽDÚ
  // objednávku v 90-dňovom okne, nie len pre tie, čo majú čo zatvárať. Jeden
  // dopyt namiesto stoviek zbytočných dotazov.
  const openRows = await tx
    .select({ dedupKey: upozornenie.dedupKey })
    .from(upozornenie)
    .where(and(eq(upozornenie.type, "objednavka_visi"), isNull(upozornenie.resolvedAt)));
  const openDedupKeys = new Set(openRows.map((r) => r.dedupKey).filter((k): k is string => k !== null));

  let stuckOrderCount = 0;
  let autoResolvedStuckOrderCount = 0;
  for (const [externalOrderId, info] of orderInfo) {
    const dedupKey = stuckOrderUpozornenieDedupKey(externalOrderId);
    if (isUnfinishedOrderStatus(info.statusName)) {
      const days = daysStuck(info.placedAt, now);
      if (days < ORDER_STUCK_THRESHOLD_DAYS) continue;
      await upsertUpozornenie(tx, {
        type: "objednavka_visi",
        source: "appka",
        title: `Objednávka ${externalOrderId} visí ${String(days)} dní v stave „${info.statusName}“`,
        details: `Zákazník: ${info.customerName}`,
        link: buildShoptetAdminOrderUrl(adminBaseUrl, externalOrderId, orderIdsByCode.get(externalOrderId) ?? null),
        dedupKey,
        now,
      });
      stuckOrderCount += 1;
      continue;
    }
    if (!openDedupKeys.has(dedupKey)) continue;
    if (await autoResolveByDedupKey(tx, dedupKey, now)) autoResolvedStuckOrderCount += 1;
  }

  return { stuckOrderCount, autoResolvedStuckOrderCount };
}
