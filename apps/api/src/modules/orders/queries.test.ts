import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildShoptetAdminOrderUrl } from "./queries.js";

// issue 120: majiteľ žiadal priamy odkaz na detail objednávky namiesto
// vyhľadávania — `buildShoptetAdminOrderUrl` je čistá funkcia (žiadna DB),
// preto VLASTNÝ unit test súbor namiesto integračného (rovnaký dôvod ako
// `supplier-key.test.ts` vedľa `supplier-key.ts`).
describe("buildShoptetAdminOrderUrl", () => {
  it("keď je interné Shoptet id známe, zloží priamy odkaz na objednavky-detail", () => {
    expect(buildShoptetAdminOrderUrl("https://www.forestshop.sk", "20261244", 58728)).toBe(
      "https://www.forestshop.sk/admin/objednavky-detail/?id=58728",
    );
  });

  it("keď id nie je známe (null), padá späť na globálne vyhľadávanie podľa kódu", () => {
    expect(buildShoptetAdminOrderUrl("https://www.forestshop.sk", "20261244", null)).toBe(
      "https://www.forestshop.sk/admin/vyhladavanie/?string=20261244&src=orders",
    );
  });

  it("fallback vetva stále escapuje kód objednávky (encodeURIComponent)", () => {
    expect(buildShoptetAdminOrderUrl("https://admin.example.sk", "7003 & test", null)).toBe(
      "https://admin.example.sk/admin/vyhladavanie/?string=7003%20%26%20test&src=orders",
    );
  });

  it("použije nakonfigurovanú doménu, nikdy natvrdo v kóde", () => {
    expect(buildShoptetAdminOrderUrl("https://admin.example.sk", "20261244", 58728)).toBe(
      "https://admin.example.sk/admin/objednavky-detail/?id=58728",
    );
  });
});

// issue 129: `NULL_GROUP_KEY` niesol skutočný `\x00` (NUL) bajt namiesto
// medzery pred "none" (zavedené ead8ae3, issue 63) — `git diff`/`git show`
// preto zaobchádzali s CELÝM súborom ako s binárnym, takže žiadny reviewer
// spoliehajúci sa na `git diff` (namiesto čítania celého obsahu) nikdy
// neuvidel žiadnu zmenu v tomto súbore (zistené na code review PR #128).
// Test číta RAW bajty vlastného zdrojového súboru priamo z disku (nie cez
// import — ten by NUL bajt v reťazcovom literáli tichým spôsobom preniesol
// ako obyčajný znak, test by nikdy nezlyhal) a overuje, že súbor neobsahuje
// ŽIADEN NUL bajt — chráni pred rovnakou náhodou v BUDÚCNOSTI, nielen dnešný
// jeden výskyt.
it("zdrojový súbor queries.ts neobsahuje NUL bajt (git diff musí ostať čitateľný)", () => {
  const cestaKSuboru = fileURLToPath(new URL("./queries.ts", import.meta.url));
  const bajty = readFileSync(cestaKSuboru);
  expect(bajty.includes(0)).toBe(false);
});
