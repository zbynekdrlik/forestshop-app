import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { productSupplierLinkOverrides } from "../src/db/schema.js";
import { collectSupplierLinks } from "../src/modules/supplier-stock/run.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

// issue 448: `collectSupplierLinks` musí čítať EFEKTÍVNY odkaz
// (`product_supplier_link_override` ∪ `internalNote` cez
// `resolveEffectiveSupplierLink`), nie len surový `internalNote` — inak
// potvrdený odkaz z Párovania zapísaný do override tabuľky ostane pre nočný
// zber neviditeľný až do Shoptet round-tripu + ďalšieho catalog syncu.

describe("collectSupplierLinks — override odkazy (issue 448)", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  it("includes a link that exists ONLY in product_supplier_link_override (internalNote has no URL)", async () => {
    // presne betalov prípad: poznámka = LEN meno dodávateľa, žiadny URL,
    // ale v Párovaní potvrdený odkaz je zapísaný do override tabuľky.
    await insertTestVariantForProduct(db, "BETA", "BETA/1", { internalNote: "betalov" });
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "BETA", url: "https://betalov.sk/produkt-x", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const links = await collectSupplierLinks(db);
    expect(links).toEqual(["https://betalov.sk/produkt-x"]);
  });

  it("still EXCLUDES a name-only note when there is no override and no URL anywhere", async () => {
    await insertTestVariantForProduct(db, "NOURL", "NOURL/1", { internalNote: "betalov" });

    const links = await collectSupplierLinks(db);
    expect(links).toEqual([]);
  });

  it("prefers the override URL over the internalNote URL, and uses internalNote when no override", async () => {
    await insertTestVariantForProduct(db, "NOTE", "NOTE/1", { internalNote: "https://dodavatel.example/z-poznamky" });
    await insertTestVariantForProduct(db, "OVR", "OVR/1", { internalNote: "https://dodavatel.example/stara" });
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "OVR", url: "https://dodavatel.example/nova-override", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const links = await collectSupplierLinks(db);
    expect(links).toEqual(["https://dodavatel.example/nova-override", "https://dodavatel.example/z-poznamky"]);
  });

  it("excludes an override that points to OUR OWN e-shop (issue 227 discipline)", async () => {
    await insertTestVariantForProduct(db, "OWN", "OWN/1", { internalNote: null });
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "OWN", url: "https://www.forestshop.sk/produkt-x", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const links = await collectSupplierLinks(db);
    expect(links).toEqual([]);
  });
});
