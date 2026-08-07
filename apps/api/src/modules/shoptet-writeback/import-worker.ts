import { runShoptetImport, type ImportWorkerInput, type ShoptetImportOutcome } from "./playwright-import.js";

/**
 * Issue 313: DIEŤA proces vstupný bod pre `runShoptetImportIsolated`
 * (`child-runner.ts`) — spustí NEZMENENÝ `runShoptetImport` (skutočný
 * Chromium beh) mimo appka's vlastného dlho bežiaceho procesu a pošle
 * výsledok späť rodičovi cez IPC. Nikdy sa nespúšťa priamo — vždy len cez
 * `fork()` z `child-runner.ts`. `csvBase64` sa tu dekóduje späť na skutočný
 * `Buffer` (`playwright-import.ts`'s `ImportWorkerInput` vysvetľuje prečo).
 */
process.once("message", (input: ImportWorkerInput) => {
  const { csvBase64, ...rest } = input;
  runShoptetImport({ ...rest, csv: Buffer.from(csvBase64, "base64") })
    .then((result: ShoptetImportOutcome) => {
      process.send?.({ ok: true, result });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.send?.({ ok: false, error: message });
    })
    .finally(() => {
      process.exit(0);
    });
});
