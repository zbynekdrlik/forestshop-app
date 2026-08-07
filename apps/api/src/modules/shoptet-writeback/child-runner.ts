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
 * `serialization: "advanced"` (V8 structured clone, nie JSON) — POZOR:
 * naživo overené, že ani TOTO neprenesie `Buffer` ako skutočnú `Buffer`
 * inštanciu (príde na druhej strane ako obyčajný `Object`) — volajúci s
 * binárnym obsahom (napr. `playwright-import.ts`'s `runShoptetImportIsolated`)
 * ho preto MUSIA poslať ako base64 reťazec a dekódovať späť VNÚTRI workera,
 * nikdy sa nespoliehať na to, že "advanced" mode Buffer prenesie bezo zmeny
 * typu. `serialization: "advanced"` tu ostáva pre ostatné JS typy (Map, Set,
 * `undefined` polia a pod.), ktoré JSON serializácia stráca/skresľuje.
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

/** Exportované LEN pre `resolve-worker.test.ts` — over VETVENIE (kompilovaný
 * `.js` vs `.ts`+tsx záložka) priamo, bez nutnosti skutočne forkovať proces
 * (code review PR 315, finding 4: produkčná `.js` vetva nemá vlastný test —
 * spustiť skutočný skompilovaný worker by potrebovalo `tsc -b` PRED testom,
 * čo by rozbilo "žiadny build pred testom" vzor tohto repa; test LOGIKY
 * vetvenia bez skutočného forku je lacnejší, rovnako dôkazný pre samotné
 * rozhodovanie). */
export function resolveWorker(workerScriptUrl: URL): { readonly modulePath: string; readonly execOptions: ForkOptions } {
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
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function runInChildProcess<TOutput>(
  workerScriptUrl: URL,
  input: Serializable,
  options: RunInChildProcessOptions = {},
): Promise<TOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { modulePath, execOptions } = resolveWorker(workerScriptUrl);
  return new Promise<TOutput>((resolve, reject) => {
    // `detached: true` dáva dieťaťu VLASTNÚ skupinu procesov (PGID == PID) —
    // pri timeoute zabíjame `-child.pid` (celú skupinu), nie len samotný
    // fork()nutý node/tsx proces. Bez toho by SIGKILL nechal Chromium
    // (VNÚTORNÉ dieťa workera, nie priame dieťa tohto fork()) osirelé —
    // presne tá istá trieda problému ako zombie nález, čo `init: true`
    // rieši pre bežnú cestu, ale NIE pre násilné ukončenie na timeout
    // (code review PR 315, finding 3).
    const child = fork(modulePath, [], {
      ...execOptions,
      detached: true,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let settled = false;

    function killChildGroup(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // skupina už neexistuje (dieťa aj jeho potomkovia už skončili) — nič
        // nerob, toto je bežný, nie chybový stav.
      }
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChildGroup("SIGKILL");
      reject(new Error(`Dieťa proces (${modulePath}) neodpovedal do ${String(timeoutMs)} ms`));
    }, timeoutMs);

    let pendingResult: { readonly ok: boolean; readonly result?: TOutput; readonly error?: string } | undefined;

    child.once("message", (raw: unknown) => {
      if (settled) return;
      if (!isWorkerMessage<TOutput>(raw)) {
        settled = true;
        clearTimeout(timer);
        killChildGroup("SIGTERM");
        reject(new Error("Dieťa proces poslal neplatnú správu"));
        return;
      }
      // NEuzatváraj promise tu — `'message'` len ZACHYTÍ výsledok. Node
      // NEZARUČUJE, že `'message'` doručí PRED `'exit'`(IPC zápis je
      // asynchrónny) — naživo overené (code review PR 315, finding 1):
      // súbežné behy pod záťažou stratili doručenú správu 100 % prípadov,
      // keď sa promise uzatvárala tu. Skutočné rozhodnutie sa robí až v
      // `'close'` nižšie, ktoré Node GARANTUJE až PO doručení/spracovaní
      // všetkých IPC správ.
      pendingResult = raw;
      killChildGroup("SIGTERM");
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    // `'close'` (nie `'exit'`) — fires AŽ PO tom, čo sa STDIO prúdy (vrátane
    // IPC kanála) skutočne zatvoria, čo garantuje, že KAŽDÁ už doručená
    // `'message'` bola spracovaná skôr, než sa sem dostaneme (code review
    // PR 315, finding 1 — over verifikované 200/200 pod záťažou po tejto
    // oprave, predtým až 100 % strata).
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingResult === undefined) {
        reject(new Error(`Dieťa proces skončil bez výsledku (exit code ${String(code)})`));
        return;
      }
      if (pendingResult.ok) {
        resolve(pendingResult.result as TOutput);
      } else {
        reject(new Error(pendingResult.error ?? "Dieťa proces zlyhal bez popisu"));
      }
    });

    child.send(input);
  });
}
