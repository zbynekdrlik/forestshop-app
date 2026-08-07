import {
  runOrderNoteWriteback,
  type OrderNoteWriteResult,
  type RunOrderNoteWritebackOptions,
} from "./order-note-playwright.js";

/**
 * Issue 313: DIEŤA proces vstupný bod pre `runOrderNoteWritebackIsolated`
 * (`child-runner.ts`) — rovnaký vzor ako `import-worker.ts`, len pre
 * per-objednávkový zápis poznámky namiesto hromadného CSV importu. Nikdy sa
 * nespúšťa priamo — vždy len cez `fork()` z `child-runner.ts`.
 */
process.once("message", (input: RunOrderNoteWritebackOptions) => {
  runOrderNoteWriteback(input)
    .then((result: readonly OrderNoteWriteResult[]) => {
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
