// issue 413: "Spustiť teraz" beží odteraz ASYNC — server vráti 202 hneď (beh
// pokračuje na pozadí), nie synchrónny výsledok priamo v POST odpovedi.
// Obrazovka preto musí VÝSLEDOK DOČÍTAŤ opakovaným `fetchStatus()`, kým
// posledný beh ešte `status === "running"`. Zdieľaný helper (rovnaký DRY
// dôvod ako `useLoadMore.ts`, issue 337) — každá zo štyroch obrazoviek s
// run-now tlačidlom (`PostaUncollectedSection`/`OrderReminderSection`/
// `RestockSection`/`SupplierStockSection`) ho volá po úspešnom "started"
// namiesto vlastnej kópie poll slučky.
export interface PolledStatus {
  readonly lastRun: { readonly status: "running" | "success" | "failure" } | null;
}

export interface PollUntilJobDoneOptions {
  /** Horná hranica intervalu medzi pokusmi (predvolene 3000ms). */
  readonly maxIntervalMs?: number;
  readonly maxAttempts?: number;
}

/**
 * Opakovane zavolá `fetchStatus()`, kým `lastRun.status === "running"` (alebo
 * kým sa vyčerpá `maxAttempts`) — vracia POSLEDNE načítaný stav (buď
 * skutočne dokončený beh, alebo stav po vyčerpaní pokusov, keď beh trvá
 * neobvykle dlho — volajúci to rozpozná podľa `lastRun.status === "running"`
 * na vrátenej hodnote).
 *
 * Interval medzi pokusmi RASTIE exponenciálne (500ms, 1s, 2s, potom stropom
 * na `maxIntervalMs`) — posta-uncollected/order-reminder sú v praxi takmer
 * OKAMŽITÉ (žiadny e2e fixtúrový riadok nemá čo reálne kontrolovať, viď
 * `.claude/rules/posta-uncollected.md`), takže obsluha vidí výsledok skoro
 * hneď, zatiaľ čo supplier-stock (~72 min, `.claude/rules/supplier-
 * stock.md`) po pár pokusoch prejde na 3s krok a nikdy nezbytočne
 * "nebombarduje" server počas skutočne dlhého behu.
 */
export async function pollUntilJobDone<S extends PolledStatus>(
  fetchStatus: () => Promise<S>,
  options: PollUntilJobDoneOptions = {},
): Promise<S> {
  const maxIntervalMs = options.maxIntervalMs ?? 3000;
  const maxAttempts = options.maxAttempts ?? 40;
  let status = await fetchStatus();
  let attempts = 0;
  while (status.lastRun !== null && status.lastRun.status === "running" && attempts < maxAttempts) {
    const delayMs = Math.min(500 * 2 ** attempts, maxIntervalMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    status = await fetchStatus();
    attempts += 1;
  }
  return status;
}
