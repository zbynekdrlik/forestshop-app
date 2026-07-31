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
