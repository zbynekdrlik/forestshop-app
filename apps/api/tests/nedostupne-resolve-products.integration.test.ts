// issue 347: majiteľove RUČNE vložené odkazy náhrad (issue 238) nesú len URL
// — appka spätne dohľadá názov/obrázok/cenu proti tomu, čo UŽ MÁ
// (shop_product_url + variants), aby e-mailová karta mala čo ukázať.

import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { shopProductUrl, variants } from "../src/db/schema.js";
import { resolveReplacementProducts } from "../src/modules/nedostupne/resolve-products.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  return ctx.db;
}

it("PRESNÁ zhoda url → vráti názov, obrázok aj naformátovanú cenu", async () => {
  const db = await boot();
  await insertTestVariant(db, "P347A", "Test dodávateľ");
  await db.insert(shopProductUrl).values({
    code: "P347A",
    url: "https://www.forestshop.sk/p347a/?variantId=1",
    fetchedAt: new Date("2026-08-11T00:00:00Z"),
    imageUrl: "https://cdn.example.sk/p347a.jpg",
  });

  const [resolved] = await resolveReplacementProducts(db, ["https://www.forestshop.sk/p347a/?variantId=1"]);
  expect(resolved).toEqual({
    url: "https://www.forestshop.sk/p347a/?variantId=1",
    label: "Test produkt P347A",
    imageUrl: "https://cdn.example.sk/p347a.jpg",
    priceText: "10,00 €",
  });
});

it("zhoda podľa CESTY (majiteľ vložil adresu bez ?variantId=, feed ju nesie S ním)", async () => {
  const db = await boot();
  await insertTestVariant(db, "P347B", "Test dodávateľ");
  await db.insert(shopProductUrl).values({
    code: "P347B",
    url: "https://www.forestshop.sk/p347b/?variantId=9",
    fetchedAt: new Date("2026-08-11T00:00:00Z"),
    imageUrl: "https://cdn.example.sk/p347b.jpg",
  });

  const [resolved] = await resolveReplacementProducts(db, ["https://www.forestshop.sk/p347b/"]);
  expect(resolved?.label).toBe("Test produkt P347B");
  expect(resolved?.imageUrl).toBe("https://cdn.example.sk/p347b.jpg");
});

it("žiadna zhoda → padne PRESNE na pôvodné správanie (label = url, žiadny obrázok/cena)", async () => {
  const db = await boot();
  const [resolved] = await resolveReplacementProducts(db, ["https://www.forestshop.sk/nikdy-nevidane/"]);
  expect(resolved).toEqual({ url: "https://www.forestshop.sk/nikdy-nevidane/", label: "https://www.forestshop.sk/nikdy-nevidane/" });
});

it("variant bez ceny → priceText chýba, ale názov/obrázok ostávajú", async () => {
  const db = await boot();
  await insertTestVariant(db, "P347C", "Test dodávateľ");
  await db.update(variants).set({ price: null, currency: null }).where(eq(variants.code, "P347C"));
  await db.insert(shopProductUrl).values({
    code: "P347C",
    url: "https://www.forestshop.sk/p347c/",
    fetchedAt: new Date("2026-08-11T00:00:00Z"),
    imageUrl: "https://cdn.example.sk/p347c.jpg",
  });

  const [resolved] = await resolveReplacementProducts(db, ["https://www.forestshop.sk/p347c/"]);
  expect(resolved).toEqual({
    url: "https://www.forestshop.sk/p347c/",
    label: "Test produkt P347C",
    imageUrl: "https://cdn.example.sk/p347c.jpg",
  });
});

it("feed bez obrázka → imageUrl chýba, názov/cena ostávajú", async () => {
  const db = await boot();
  await insertTestVariant(db, "P347D", "Test dodávateľ");
  await db.insert(shopProductUrl).values({
    code: "P347D",
    url: "https://www.forestshop.sk/p347d/",
    fetchedAt: new Date("2026-08-11T00:00:00Z"),
  });

  const [resolved] = await resolveReplacementProducts(db, ["https://www.forestshop.sk/p347d/"]);
  expect(resolved).toEqual({ url: "https://www.forestshop.sk/p347d/", label: "Test produkt P347D", priceText: "10,00 €" });
});

it("zachová poradie vstupu pri viacerých url naraz", async () => {
  const db = await boot();
  await insertTestVariant(db, "P347E1", "Test dodávateľ");
  await insertTestVariant(db, "P347E2", "Test dodávateľ");
  await db.insert(shopProductUrl).values([
    { code: "P347E1", url: "https://www.forestshop.sk/e1/", fetchedAt: new Date("2026-08-11T00:00:00Z") },
    { code: "P347E2", url: "https://www.forestshop.sk/e2/", fetchedAt: new Date("2026-08-11T00:00:00Z") },
  ]);

  const resolved = await resolveReplacementProducts(db, ["https://www.forestshop.sk/e2/", "https://www.forestshop.sk/e1/"]);
  expect(resolved.map((r) => r.label)).toEqual(["Test produkt P347E2", "Test produkt P347E1"]);
});
