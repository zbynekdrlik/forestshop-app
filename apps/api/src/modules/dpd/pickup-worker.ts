import { runOrderDpdPickup, type OrderDpdPickupOutcome, type OrderPickupWorkerInput } from "./pickup-playwright.js";

/** Issue 292: rovnaký vzor ako `shipment-worker.ts` — DIEŤA proces vstupný
 * bod pre `runOrderDpdPickupIsolated`. */
function sendAndExit(message: { readonly ok: boolean; readonly result?: OrderDpdPickupOutcome; readonly error?: string }): void {
  const exitCode = message.ok ? 0 : 1;
  if (process.send === undefined) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
}

process.once("message", (input: OrderPickupWorkerInput) => {
  runOrderDpdPickup(input)
    .then((result: OrderDpdPickupOutcome) => {
      sendAndExit({ ok: true, result });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendAndExit({ ok: false, error: message });
    });
});
