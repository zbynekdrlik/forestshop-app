import { runCreateDpdShipment, type CreateDpdShipmentOutcome, type CreateShipmentWorkerInput } from "./shipment-playwright.js";

/**
 * Issue 292: DIEŤA proces vstupný bod pre `runCreateDpdShipmentIsolated`
 * (`child-runner.ts`, zdieľaný s `shoptet-writeback`) — rovnaký vzor ako
 * `shoptet-writeback/import-worker.ts`. Nikdy sa nespúšťa priamo, vždy len
 * cez `fork()` z `child-runner.ts`.
 */
function sendAndExit(message: { readonly ok: boolean; readonly result?: CreateDpdShipmentOutcome; readonly error?: string }): void {
  const exitCode = message.ok ? 0 : 1;
  if (process.send === undefined) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
}

process.once("message", (input: CreateShipmentWorkerInput) => {
  runCreateDpdShipment(input)
    .then((result: CreateDpdShipmentOutcome) => {
      sendAndExit({ ok: true, result });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendAndExit({ ok: false, error: message });
    });
});
