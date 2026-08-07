import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// issue 319: `createApp(db, {...})` v `index.ts` MUSÍ obsahovať `restock`
// kľúč, rovnakým vzorom ako `postaUncollected`/`orderReminder`/
// `nedostupne`/`orderMerge`/`dpd` — bez neho appka vždy volá
// `registerRestockRoutes` (`http/app.ts`) s PRÁZDNYMI prihlasovacími
// údajmi (jeho fail-closed fallback: `shoptetImportConfigFromBaseUrl(...,
// "", "")`), takže tlačidlo "Spustiť teraz" na obrazovke "Vypredané →
// Skladom" v produkcii vždy zlyhá na prihlásení do Shoptetu, hoci
// `SHOPTET_ADMIN_USER`/`PASSWORD` sú reálne nastavené a naplánovaný nočný
// beh (`restockJob(runRestockFn)`) beží normálne — má VLASTNÚ, správne
// zostavenú `runRestockFn`, ktorá do `createApp` nikdy nešla.
//
// `index.ts` beží celý na module-top-level (migrácia + pripojenie k DB +
// `serve()`) — nedá sa bezpečne importovať ani zavolať priamo v teste.
// Jediný spoľahlivý spôsob dokázať, že sa táto medzera nikdy nevráti, je
// overiť ZDROJOVÝ TEXT statický: nájsť `createApp(db, {...})` volanie a
// overiť, že jeho `restock:` kľúč skutočne referuje reálne
// `shoptetAdminUser`/`shoptetAdminPassword` premenné (nie len že reťazec
// "restock" niekde v súbore existuje).
describe("index.ts wiring: createApp dostáva restock deps (issue 319)", () => {
  it("createApp(db, {...}) volanie obsahuje restock kľúč postavený na SHOPTET_ADMIN_USER/PASSWORD premenných", () => {
    const indexSrc = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    const callMatch = /const app = createApp\(db, \{[\s\S]*?\}\);/.exec(indexSrc);
    expect(callMatch, "createApp(db, {...}) volanie sa v index.ts nenašlo").not.toBeNull();
    const callBlock = callMatch?.[0] ?? "";

    expect(callBlock).toMatch(/restock:\s*\{\s*config:\s*shoptetImportConfigFromBaseUrl\(/);
    // Nesmie ísť o nový fail-closed literál priamo v index.ts (to by len
    // presunulo tú istú medzeru inam) — musí použiť REÁLNE premenné, ktoré
    // `runRestockFn` (o pár riadkov vyššie) už zostavuje pre scheduler.
    expect(callBlock).toMatch(/shoptetAdminUser\s*\?\?\s*""/);
    expect(callBlock).toMatch(/shoptetAdminPassword\s*\?\?\s*""/);
  });
});
