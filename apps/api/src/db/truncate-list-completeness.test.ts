import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is, Table, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

// issue 384: "upozornenie" tabuľka chýbala v OBOCH ručne udržiavaných
// TRUNCATE zoznamoch (`tests/helpers/db.ts`'s `withCleanDb()` a
// `scripts/e2e-setup.ts`) — presne tá istá trieda medzery ako issue 217
// (`.claude/rules/testing.md`), tentoraz v OBOCH súčasne. Tento test
// nekontroluje BEHOVÉ správanie (viď design komentár na tickete — CASCADE
// cez "users"/"product"/"order" už dnes FUNKČNE zasiahne aj nevymenovanú
// tabuľku), ale KOMPLETNOSŤ samotného zoznamu — presne to, čo obe súbory
// zámerne robia (`pairing`/`order_line` sú vymenované explicitne, hoci by
// ich CASCADE strhol aj bez toho, "kvôli sebadokumentujúcej dôslednosti").
// Bez tohto testu môže ĎALŠIA nová "koreňová" tabuľka BEZ FK do žiadnej už
// uvedenej (na rozdiel od dnešných šiestich) ticho prežiť medzi behmi a
// nikto si to nevšimne, kým sa neprejaví ako nevysvetliteľný medzi-testový
// stav (presne popis issue 217/384).
//
// Zámerne v `src/` (nie `tests/`) — test nepotrebuje DATABASE_URL, ide len
// o statickú introspekciu zdrojového textu oboch súborov (`readFileSync`) a
// drizzle schémy (`is`/`getTableName`), žiadny DB dotaz. `src/**/*.test.ts`
// beží v rýchlom `pnpm --filter @forestshop/api test` (bez DB, súčasť
// lokálneho `gates:local` aj CI `check` jobu) — presunutím do
// DB-vyžadujúceho `test:integration` by táto regresia bola odhalená až po
// pushi, nikdy pri bežnom lokálnom behu (`.claude/rules/testing.md`).

function extractTruncateTableList(fileContents: string): Set<string> {
  const match = /TRUNCATE TABLE ([^`']*?) RESTART IDENTITY CASCADE/.exec(fileContents);
  if (match?.[1] === undefined) {
    throw new Error("Nenašiel som TRUNCATE TABLE ... RESTART IDENTITY CASCADE v súbore");
  }
  return new Set(
    match[1]
      .split(",")
      .map((name) => name.trim().replaceAll('"', ""))
      .filter((name) => name.length > 0),
  );
}

function allSchemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, Table)) {
      names.push(getTableName(value));
    }
  }
  return names;
}

describe("TRUNCATE zoznamy pokrývajú KAŽDÚ tabuľku v drizzle schéme (issue 384)", () => {
  it("apps/api/tests/helpers/db.ts's withCleanDb() TRUNCATE zoznam obsahuje všetky tabuľky", () => {
    const dbHelperPath = fileURLToPath(new URL("../../tests/helpers/db.ts", import.meta.url));
    const contents = readFileSync(dbHelperPath, "utf8");
    const listed = extractTruncateTableList(contents);
    const missing = allSchemaTableNames().filter((name) => !listed.has(name));
    expect(missing).toEqual([]);
  });

  it("scripts/e2e-setup.ts's TRUNCATE zoznam obsahuje všetky tabuľky", () => {
    const e2eSetupPath = fileURLToPath(new URL("../../../../scripts/e2e-setup.ts", import.meta.url));
    const contents = readFileSync(e2eSetupPath, "utf8");
    const listed = extractTruncateTableList(contents);
    const missing = allSchemaTableNames().filter((name) => !listed.has(name));
    expect(missing).toEqual([]);
  });
});
