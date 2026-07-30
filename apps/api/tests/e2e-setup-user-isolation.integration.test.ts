// #32: `apps/web/tests/e2e/orders.spec.ts`'s prvý test niekedy zlyhával pri
// súbežnom Playwright behu (`--workers=2`) — koreňová príčina bola, že
// `login.spec.ts`'s test zmeny hesla DOČASNE menil skutočné heslo ZDIEĽANÉHO
// e2e účtu (`e2e@forestshop.sk`), ktorý súčasne používajú aj
// `catalog.spec.ts`/`orders.spec.ts` v inom, súbežne bežiacom workeri — súbežné
// `POST /api/login` s naprogramovaným pôvodným heslom potom spadlo presne do
// okna medzi zmenou a vrátením hesla a dostalo skutočný 401. Reprodukované a
// zdokumentované na tickete (5× `pnpm --filter @forestshop/web e2e --workers=2`,
// 4× zlyhalo, koreláciou timestampov potvrdené presne toto).
//
// Oprava: `login.spec.ts`'s test zmeny hesla dostal VLASTNÝ, IZOLOVANÝ účet
// (`E2E_HESLO_ZMENA_EMAIL` v `scripts/e2e-setup.ts`) — jediný, ktorého heslo sa
// kedy mení. Tento test to dokazuje SPUSTENÍM SKUTOČNÉHO `scripts/e2e-setup.ts`
// ako podproces (rovnaký vzor ako `catalog-ingest-script.integration.test.ts` —
// nie preimplementovaná kópia, aby chytil aj budúcu regresiu priamo v skripte),
// a potom priamym volaním `login()`/`changePassword()` (mimo HTTP, teda mimo
// `login-rate-limit.ts`'s modulového singletonu — ten NIE je táto chyba, pozri
// komentár na #32) overí: zmena hesla DEDIKOVANÉHO účtu nikdy neovplyvní
// prihlásenie ZDIEĽANÉHO účtu, aj keď sa oba spočiatku delia o rovnaké heslo.
//
// RED pred opravou #32: skript seedoval JEDNÉHO e2e používateľa
// (`e2e@forestshop.sk`) — dedikovaný `E2E_HESLO_ZMENA_EMAIL` účet v DB vôbec
// neexistoval, takže druhé `login()` nižšie vráti `null` namiesto session a
// test zlyhá skôr, než sa dostane k samotnému dôkazu izolácie.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { changePassword } from "../src/modules/auth/change-password.js";
import { login } from "../src/modules/auth/service.js";
import { users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

// `tests/` je `apps/api/tests/` — tri úrovne hore je koreň repozitára, kde žije
// `scripts/e2e-setup.ts` aj `node_modules/.bin/tsx` (rovnaký vzor ako
// `catalog-ingest-script.integration.test.ts`).
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/e2e-setup.ts");

// Musia sa zhodovať so `scripts/e2e-setup.ts` a `apps/web/tests/e2e/login.spec.ts`.
const ZDIELANY_EMAIL = "e2e@forestshop.sk";
const ZMENA_EMAIL = "e2e-heslo@forestshop.sk";
const PUVODNE_HESLO = "e2e-test-heslo";
const NOVE_HESLO_LEN_PRE_TEST = "iny-e2e-izolacny-test-heslo-xyz";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

function runSetupScript(databaseUrl: string): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr });
    });
  });
}

it(
  "#32: zmena hesla dedikovaného e2e účtu nikdy neovplyvní prihlásenie zdieľaného e2e účtu",
  async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error("Integračné testy potrebujú DATABASE_URL na testovaciu databázu");
    }

    const result = await runSetupScript(databaseUrl);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    const now = new Date("2026-07-30T10:00:00Z");

    // Sanity: oba účty existujú a spočiatku majú ROVNAKÉ heslo — presne to, čo
    // `scripts/e2e-setup.ts` seeduje.
    const zdielanaSession = await login(ctx.db, { email: ZDIELANY_EMAIL, password: PUVODNE_HESLO, now });
    if (zdielanaSession === null) throw new Error("zdieľaný e2e účet sa neprihlásil pôvodným heslom");
    const zmenaSession = await login(ctx.db, { email: ZMENA_EMAIL, password: PUVODNE_HESLO, now });
    if (zmenaSession === null) throw new Error("dedikovaný e2e účet sa neprihlásil pôvodným heslom");

    const [zmenaUser] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, ZMENA_EMAIL));
    if (zmenaUser === undefined) throw new Error("dedikovaný e2e účet nebol po behu skriptu nájdený");

    const zmenaVysledok = await changePassword(ctx.db, {
      userId: zmenaUser.id,
      oldPassword: PUVODNE_HESLO,
      newPassword: NOVE_HESLO_LEN_PRE_TEST,
      currentSessionToken: zmenaSession.token,
      now,
    });
    expect(zmenaVysledok).toBe("ok");

    // Sanity: dedikovaný účet teraz pôvodné heslo skutočne odmieta — dôkaz, že
    // zmena reálne prebehla, nie len že volanie vrátilo "ok".
    await expect(
      login(ctx.db, { email: ZMENA_EMAIL, password: PUVODNE_HESLO, now }),
    ).resolves.toBeNull();

    // Samotný dôkaz izolácie (#32): ZDIEĽANÝ účet, ktorého heslo nikto nemenil,
    // sa PRESNE V TEJTO CHVÍLI — keď je heslo DEDIKOVANÉHO účtu už zmenené — stále
    // prihlási svojím pôvodným, nezmeneným heslom. Ak by oba e-maily mierili na
    // TEN ISTÝ riadok (alebo ak by dedikovaný účet vôbec neexistoval a test by
    // padol vyššie), toto by zlyhalo presne tak, ako #32 zlyhával v Playwrighte.
    await expect(
      login(ctx.db, { email: ZDIELANY_EMAIL, password: PUVODNE_HESLO, now }),
    ).resolves.not.toBeNull();
  },
  20_000,
);
