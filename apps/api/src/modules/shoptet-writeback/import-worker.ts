import { runShoptetImport, type ImportWorkerInput, type ShoptetImportOutcome } from "./playwright-import.js";

/**
 * Issue 313: DIEŤA proces vstupný bod pre `runShoptetImportIsolated`
 * (`child-runner.ts`) — spustí NEZMENENÝ `runShoptetImport` (skutočný
 * Chromium beh) mimo appka's vlastného dlho bežiaceho procesu a pošle
 * výsledok späť rodičovi cez IPC. Nikdy sa nespúšťa priamo — vždy len cez
 * `fork()` z `child-runner.ts`. `csvBase64` sa tu dekóduje späť na skutočný
 * `Buffer` (`playwright-import.ts`'s `ImportWorkerInput` vysvetľuje prečo).
 */

// `process.send(msg, callback)` — NIKDY holé `process.send(msg)` + `exit()`
// hneď potom. Node negarantuje, že `'message'` na strane rodiča príde PRED
// `'exit'`/`'close'` (asynchrónny IPC zápis) — naživo overené (code review
// PR 315, finding 1): pod záťažou stratil rodič doručenú správu až 100 %
// prípadov, keď dieťa exitovalo skôr, než zápis skutočne odišiel. Callback
// tu čaká na SKUTOČNÉ odoslanie pred `process.exit`. Ak `process.send`
// chýba (bez IPC kanála — nemalo by sa stať, vždy sa spúšťa cez `fork()`),
// exituj rovno, aby proces nikdy nezostal visieť.
function sendAndExit(message: { readonly ok: boolean; readonly result?: ShoptetImportOutcome; readonly error?: string }): void {
  const exitCode = message.ok ? 0 : 1;
  if (process.send === undefined) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
}

process.once("message", (input: ImportWorkerInput) => {
  const { csvBase64, ...rest } = input;
  runShoptetImport({ ...rest, csv: Buffer.from(csvBase64, "base64") })
    .then((result: ShoptetImportOutcome) => {
      sendAndExit({ ok: true, result });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendAndExit({ ok: false, error: message });
    });
});
