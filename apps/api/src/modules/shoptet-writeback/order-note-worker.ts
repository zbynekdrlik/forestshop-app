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

// Rovnaký dôvod ako `import-worker.ts`'s `sendAndExit` — čakaj na SKUTOČNÉ
// odoslanie IPC správy pred `process.exit`, nikdy holé `process.send()` +
// okamžitý exit (code review PR 315, finding 1).
function sendAndExit(message: {
  readonly ok: boolean;
  readonly result?: readonly OrderNoteWriteResult[];
  readonly error?: string;
}): void {
  const exitCode = message.ok ? 0 : 1;
  if (process.send === undefined) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
}

process.once("message", (input: RunOrderNoteWritebackOptions) => {
  runOrderNoteWriteback(input)
    .then((result: readonly OrderNoteWriteResult[]) => {
      sendAndExit({ ok: true, result });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendAndExit({ ok: false, error: message });
    });
});
