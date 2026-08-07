import { existsSync } from "node:fs";
import { fork, type ForkOptions, type Serializable } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Issue 313: spustí `input` v KRÁTKO ŽIJÚCOM DIEŤA procese (`workerScriptUrl`
 * — vždy odkazuje na skompilovaný `.js` súbor v `dist/`, aj z volajúceho
 * kódu, ktorý sám ešte nie je skompilovaný — pozri `resolveWorker` nižšie)
 * namiesto v bežiacom appka procese. Naživo overené na produkcii (desiatky
 * opakovaných A/B testov, `.claude/rules/shoptet-writeback.md`): appka's
 * vlastný dlho bežiaci proces spúšťal Chromium PRIAMO v sebe a `.fill()` na
 * prihlasovacie polia v ňom nedržalo vyplnenú hodnotu (naprieč HTTP aj
 * scheduler spúšťacím kanálom), hoci ÚPLNE TEN ISTÝ kód spustený ako čerstvý
 * samostatný proces funguje spoľahlivo. Presný nízko-úrovňový mechanizmus sa
 * nepodarilo vystopovať, ale IZOLÁCIA je overená ako spoľahlivá oprava —
 * táto funkcia je jediné miesto, ktoré ju implementuje, aby ju vedeli
 * zdieľať `runShoptetImport` (CSV import) aj `runOrderNoteWriteback`
 * (poznámka objednávky), obe spúšťajú Chromium cez tú istú
 * `loginToShoptetAdmin`.
 *
 * `serialization: "advanced"` (V8 structured clone, nie JSON) — `input`
 * môže niesť `Buffer` (CSV obsah) priamo, bez ručného base64 kódovania.
 */
export interface RunInChildProcessOptions {
  readonly timeoutMs?: number;
}

interface WorkerMessage<TOutput> {
  readonly ok: boolean;
  readonly result?: TOutput;
  readonly error?: string;
}

function isWorkerMessage<TOutput>(value: unknown): value is WorkerMessage<TOutput> {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  return typeof value.ok === "boolean";
}

// `tests/` (integračné testy) aj `src/` (unit testy) bežia priamo cez vitest
// bez samostatného `tsc -b` buildu — v tom prípade `dist/.../<worker>.js`
// ešte neexistuje. Repo koreň je 5 úrovní nad `dist/modules/shoptet-
// writeback/child-runner.js` (produkcia) AJ nad `src/modules/shoptet-
// writeback/child-runner.ts` (rovnaká hĺbka v oboch prípadoch — `apps/api/
// {dist|src}/modules/shoptet-writeback/`), takže jeden literál pokrýva obe.
// Rovnaký vzor ako `apps/api/tests/e2e-setup-user-isolation.integration
// .test.ts`'s `TSX_BIN` — tsx JE k dispozícii lokálne/v CI (devDependency),
// ale NIKDY v produkčnom obraze (`pnpm install --prod`), preto sa použije
// LEN ako záložka, keď skompilovaný `.js` súbor chýba.
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");

function resolveWorker(workerScriptUrl: URL): { readonly modulePath: string; readonly execOptions: ForkOptions } {
  const jsPath = fileURLToPath(workerScriptUrl);
  if (existsSync(jsPath)) {
    return { modulePath: jsPath, execOptions: {} };
  }
  // Skompilovaný .js chýba — bežíme zo zdrojového `src/` (test/dev, žiadny
  // build). Spusti SESTERSKÝ `.ts` súbor cez tsx namiesto plain node.
  const tsPath = jsPath.replace(/\.js$/, ".ts");
  return { modulePath: tsPath, execOptions: { execPath: TSX_BIN } };
}

// Najdlhší naživo nameraný beh (CSV import proti reálnemu Shoptetu) je
// ~30 s (`.claude/rules/supplier-stock.md`'s poznámka o meraní trvania
// celého supplier-stock behu je iný beh; TENTO strop je pre JEDEN Playwright
// login+import/zápis, nie pre celý nočný sweep) — 5 minút je bohatá rezerva.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function runInChildProcess<TOutput>(
  workerScriptUrl: URL,
  input: Serializable,
  options: RunInChildProcessOptions = {},
): Promise<TOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { modulePath, execOptions } = resolveWorker(workerScriptUrl);
  return new Promise<TOutput>((resolve, reject) => {
    const child = fork(modulePath, [], {
      ...execOptions,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Dieťa proces (${modulePath}) neodpovedal do ${String(timeoutMs)} ms`));
    }, timeoutMs);

    child.once("message", (raw: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (!isWorkerMessage<TOutput>(raw)) {
        reject(new Error("Dieťa proces poslal neplatnú správu"));
        return;
      }
      if (raw.ok) {
        resolve(raw.result as TOutput);
      } else {
        reject(new Error(raw.error ?? "Dieťa proces zlyhal bez popisu"));
      }
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Dieťa proces skončil bez výsledku (exit code ${String(code)})`));
    });

    child.send(input);
  });
}
