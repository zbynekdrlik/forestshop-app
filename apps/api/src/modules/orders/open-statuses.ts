import { asc } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderOpenStatuses, orders } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { normalizeStatusName } from "./parser.js";

// issue 59: rovnaké obranné hranice ako stará appka's `ORDER_STATUS_MAX`/
// `ORDERS_UNKNOWN_STATUS_MAXLEN` (`export_helpers.py`/`app.py`) — stav je
// voľný text, ktorý zadáva správca, a nekonečne dlhý/nekonečne veľký zoznam
// by bol len obranné ihrisko na omyl (vložený celý súbor namiesto zoznamu
// stavov), nie legitímne použitie. Bežná appka má rádovo jednotky stavov.
const STATUS_NAME_MAX_LENGTH = 120;
const OPEN_STATUSES_MAX_COUNT = 50;
const KNOWN_STATUSES_MAX_COUNT = 200;

// Rovnaká hodnota, akú migrácia `0012_tiresome_gamma_corps.sql` seeduje do
// `order_open_status` (a `order.status_name`'s DB `default` v `schema-
// orders.ts`) — vytiahnuté sem ako pomenovaná konštanta, aby ju testové
// pomôcky (`tests/helpers/db.ts`, `scripts/e2e-setup.ts`), ktoré po TRUNCATE
// musia tento "čerstvo zmigrovaný" stav znova zostaviť RUČNE (nová koreňová
// tabuľka, `.claude/rules/testing.md`), nemuseli opakovať ako magický reťazcový
// literál. SQL v migrácii ju nemôže importovať priamo — ak sa táto hodnota
// niekedy zmení, migrácia aj tu uvedené volania treba zmeniť SPOLU.
export const DEFAULT_ORDER_OPEN_STATUS = "Vybavuje sa";

export interface ReplaceOpenStatusesInput {
  readonly statuses: readonly string[];
  readonly actorUserId: string;
  readonly now: Date;
}

export type ReplaceOpenStatusesResult =
  | { readonly status: "ok"; readonly statuses: readonly string[] }
  // Prázdny zoznam by natrvalo vyprázdnil "Na objednanie" pre KAŽDÚ
  // objednávku (žiadny nakonfigurovaný stav = nič sa nezhoduje) — rovnaká
  // obrana ako stará appka's `ORDER_STATUS_REQUIRED` pre `to_order`, len bez
  // jej "impact preview" mechanizmu (ten patrí k funkciám, ktoré táto appka
  // nemá, viď návrhový komentár na #59).
  | { readonly status: "empty" };

/**
 * Vyčistí vstup správcu: normalizácia (rovnaká ako pri importe, aby sa
 * porovnávacia forma nikdy nerozišla), orezanie prázdnych, odstránenie
 * duplicít (poradie prvého výskytu), orezanie na rozumný počet/dĺžku.
 * Rovnaký zámer ako stará appka's `_clean_status_list`, len pre JEDEN
 * zoznam namiesto štyroch.
 */
function cleanStatusList(statuses: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of statuses) {
    const value = normalizeStatusName(raw).slice(0, STATUS_NAME_MAX_LENGTH);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= OPEN_STATUSES_MAX_COUNT) break;
  }
  return out;
}

/** Nastavené stavy, ktoré sa počítajú ako "objednávka sa ešte vybavuje" —
 * abecedne, pre stabilné, ľahko overiteľné poradie na obrazovke. */
export async function listOpenStatusNames(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ statusName: orderOpenStatuses.statusName })
    .from(orderOpenStatuses)
    .orderBy(asc(orderOpenStatuses.statusName));
  return rows.map((r) => r.statusName);
}

// Distinct hodnoty `order.status_name`, aké appka SKUTOČNE videla v
// exportoch — pomôcka pre správcu (rovnaký zámer ako stará appka's
// `export_statuses`), aby si pri úprave zoznamu vedel overiť, či nezapísal
// preklep. Prázdny reťazec (nenaimportovaná/ručne vložená objednávka bez
// stavu) sa vynecháva — nie je to skutočný Shoptet stav, len DB default.
export async function listKnownStatusNames(db: Database): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ statusName: orders.statusName })
    .from(orders)
    .orderBy(asc(orders.statusName))
    .limit(KNOWN_STATUSES_MAX_COUNT);
  return rows.map((r) => r.statusName).filter((s) => s !== "");
}

/** Nahradí CELÝ nastavený zoznam naraz (rovnaký zámer ako stará appka's
 * uloženie textarea obsahu) — jedna transakcia, spolu s auditovým záznamom,
 * rovnaký vzor ako `orders/state.ts`'s `setOrderLineState`. */
export async function replaceOpenStatusNames(
  db: Database,
  input: ReplaceOpenStatusesInput,
): Promise<ReplaceOpenStatusesResult> {
  const cleaned = cleanStatusList(input.statuses);
  if (cleaned.length === 0) return { status: "empty" };

  await db.transaction(async (tx) => {
    await tx.delete(orderOpenStatuses);
    await tx.insert(orderOpenStatuses).values(cleaned.map((statusName) => ({ statusName })));
    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order_open_status.changed",
      entity: "order_open_status",
      data: { statuses: cleaned },
    });
  });

  return { status: "ok", statuses: cleaned };
}
