// `scripts/catalog-ingest.ts` je jeden z dvoch produkčných vstupných bodov
// (spúšťaný cez `pnpm catalog:ingest`, review final-wave-b položka 1) — dnes
// nemal žiadny test, ktorý by pripol jeho EXIT KÓD. Operátor sa podľa
// `.claude/rules/catalog.md` spolieha na `$?`, nie len na text výstupu — skript,
// ktorý po odmietnutom importe ticho skončí s kódom 0, je presne ten spôsob,
// akým sa prevádzkovateľ dozvie o "úspešnom" importe, hoci katalóg je stále
// zastaraný. Tento test spúšťa SKUTOČNÝ skript ako podproces (cez `tsx`, rovnako
// ako `pnpm catalog:ingest`), nikdy len funkciu, ktorú skript volá — inak by
// nechytil regresiu v samotnom skripte (napr. niekto zabudne nastaviť
// `process.exitCode`).
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { REQUIRED_COLUMNS } from "../src/modules/catalog/validation.js";
import { withCleanDb } from "./helpers/db.js";

// `tests/` je `apps/api/tests/` — tri úrovne hore je koreň repozitára, kde žije
// `scripts/catalog-ingest.ts` aj `node_modules/.bin/tsx`.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/catalog-ingest.ts");

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
  }
  server = undefined;
});

interface ScriptRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(env: NodeJS.ProcessEnv): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [SCRIPT_PATH], { cwd: REPO_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/** Env bez `SHOPTET_EXPORT_URL` — základ pre "chýbajúca URL" a doplnok pre ostatné. */
function baseEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["SHOPTET_EXPORT_URL"];
  return { ...env, ...overrides };
}

/** Lokálny HTTP server, ktorý na KAŽDÚ požiadavku odpovie tým istým telom. */
function serveBody(body: Buffer): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(body);
    });
    server = srv;
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${String(port)}/export.csv` });
    });
  });
}

/**
 * Syntetický export, ktorý prejde `DEFAULT_SNAPSHOT_LIMITS` (skutočný skript
 * limity z testu neprijíma — beží vždy s produkčnými): aspoň 1 000 000 bajtov,
 * aspoň 1 000 riadkov, všetky POVINNÉ stĺpce, žiadny riadok s problémom (každý
 * kód aj guid unikátny). Iba ASCII znaky — cp1250 a utf8 sa v tomto rozsahu
 * zhodujú, takže dekódovanie `windows-1250` v skripte vráti presne tento text.
 */
function buildAcceptableExport(rowCount: number): Buffer {
  const header = REQUIRED_COLUMNS.join(";");
  const padding = "X".repeat(120); // dorovnáva riadok nad 1 000 000 bajtov spolu
  const lines: string[] = [header];
  for (let i = 0; i < rowCount; i += 1) {
    const values: Record<string, string> = {
      code: `ITEM${String(i)}`,
      guid: `GUID${String(i)}`,
      pairCode: "",
      name: `Testovací produkt ${String(i)} ${padding}`,
      supplier: "Dodavatel",
      price: "10,00",
      standardPrice: "10,00",
      purchasePrice: "5,00",
      currency: "EUR",
      includingVat: "1",
      percentVat: "20,00",
      actionPrice: "",
      actionFrom: "",
      actionUntil: "",
      stock: "5",
      availabilityInStock: "Skladom",
      availabilityOutOfStock: "Vypredané",
      productVisibility: "visible",
      variantVisibility: "1",
    };
    lines.push(REQUIRED_COLUMNS.map((column) => values[column] ?? "").join(";"));
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

it("chýbajúce SHOPTET_EXPORT_URL: skript zlyhá nahlas s nenulovým exit kódom", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-ingest-script-"));

  const result = await runScript(baseEnv({ DATABASE_URL: process.env["DATABASE_URL"] ?? "", CATALOG_RAW_DIR: rawDir }));

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("SHOPTET_EXPORT_URL");
});

it("odmietnutý import (export príliš malý): skript skončí s exit kódom 1 a dôvodom vo výstupe", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-ingest-script-"));

  // 10 bajtov je ďaleko pod `DEFAULT_SNAPSHOT_LIMITS.minByteSize` (1 000 000) —
  // odmietne sa hneď na bajtovej bráne, bez ohľadu na obsah.
  const { url } = await serveBody(Buffer.from("x".repeat(10)));

  const result = await runScript(
    baseEnv({
      DATABASE_URL: process.env["DATABASE_URL"] ?? "",
      CATALOG_RAW_DIR: rawDir,
      SHOPTET_EXPORT_URL: url,
    }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("Import odmietnutý");
});

it("prijatý import: skript skončí s exit kódom 0 a hláškou o úspechu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-ingest-script-"));

  const body = buildAcceptableExport(6_000);
  expect(body.byteLength).toBeGreaterThan(1_000_000); // sanity — inak by test overoval len bajtovú bránu, nie prijatie

  const { url } = await serveBody(body);

  const result = await runScript(
    baseEnv({
      DATABASE_URL: process.env["DATABASE_URL"] ?? "",
      CATALOG_RAW_DIR: rawDir,
      SHOPTET_EXPORT_URL: url,
    }),
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Import prijatý");
  expect(result.stdout).toContain("6000");
});
