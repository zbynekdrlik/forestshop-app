import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorker } from "./child-runner.js";

// Issue 313, code review PR 315 finding 4: `runInChildProcess` skutočne
// spustí produkčnú (skompilovaný `.js`, plain `node`) vetvu LEN v Docker
// obraze — vitest v tomto repe nikdy nebeží proti `tsc -b` výstupu, takže tá
// vetva nemá vlastný test pri KAŽDOM behu. Skutočne SPUSTIŤ dieťa proces by
// si vyžadovalo build pred testom (rozbilo by "žiadny build pred testom"
// vzor tohto repa) — namiesto toho tento test overuje SAMOTNÉ VETVENIE
// (`resolveWorker`), ktoré rozhoduje MEDZI oboma cestami, priamo a lacno.
describe("resolveWorker (issue 313 — kompilovaný .js vs .ts+tsx záložka)", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("keď skompilovaný .js SÚBOR EXISTUJE, spustí ho priamo plain nodom (žiadny execPath override)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolve-worker-"));
    const jsPath = join(tmpDir, "some-worker.js");
    await writeFile(jsPath, "// fake compiled worker\n");

    const { modulePath, execOptions } = resolveWorker(pathToFileURL(jsPath));

    expect(modulePath).toBe(jsPath);
    expect(execOptions.execPath).toBeUndefined();
  });

  it("keď skompilovaný .js súbor CHÝBA, spustí sesterský .ts cez tsx (node_modules/.bin/tsx)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolve-worker-"));
    const jsPath = join(tmpDir, "missing-worker.js");
    // .js súbor sa NIKDY nevytvorí — presne stav testov/lokálneho vývoja.

    const { modulePath, execOptions } = resolveWorker(pathToFileURL(jsPath));

    expect(modulePath).toBe(join(tmpDir, "missing-worker.ts"));
    expect(execOptions.execPath).toMatch(/node_modules[/\\]\.bin[/\\]tsx$/);
  });
});
