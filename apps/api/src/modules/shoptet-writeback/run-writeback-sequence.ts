import type { Database } from "../../db/client.js";
import type { ShoptetImportConfig } from "./config.js";
import { isStateWritebackEnabled } from "./state-writeback-settings.js";
import { runShoptetStateWriteback, type StateWritebackRunResult } from "./run-state-writeback.js";
import { runShoptetWriteback, type WritebackRunResult } from "./run-writeback.js";

export interface ShoptetWritebackSequenceResult {
  readonly link: WritebackRunResult;
  readonly state: StateWritebackRunResult | { readonly status: "disabled" };
}

/**
 * issue 387 E7 — čo teraz beží na `:50` (`scheduler/jobs.ts`'s
 * `shoptetWritebackJob`, cez `index.ts`'s `runShoptetWritebackFn`): DVA
 * nezávislé importy v sekvencii, najprv linkový (existujúci, issue 122),
 * potom stavový (nový — mení viditeľnosť produktov na živom shope, preto
 * gatovaný vlastným Štart/Stop prepínačom, default VYPNUTÝ). Zámerne
 * NEZÁVISLÉ (design komentár na tickete, "Zvažované prístupy" bod 2):
 * zlyhanie linkového importu nesmie zabrániť POKUSU o stavový — ide o inú,
 * disjunktnú množinu riadkov v inom súbore.
 *
 * `now` sa zachytí RAZ (job-level, `scheduler.ts`) a odovzdá OBOM
 * podbehom — rovnaký "čas štartu CELÉHO behu" race guard vzor ako dnešný
 * `syncedAt`, len teraz zdieľaný dvomi nezávislými race guardmi
 * (`markSuppliersLinksSynced`/`markStateSynced`) naraz.
 */
export async function runShoptetWritebackSequence(
  db: Database,
  config: ShoptetImportConfig,
  now: Date,
): Promise<ShoptetWritebackSequenceResult> {
  const link = await runShoptetWriteback(db, config, now);
  const stateEnabled = await isStateWritebackEnabled(db);
  const state = stateEnabled ? await runShoptetStateWriteback(db, config, now) : ({ status: "disabled" } as const);
  return { link, state };
}
