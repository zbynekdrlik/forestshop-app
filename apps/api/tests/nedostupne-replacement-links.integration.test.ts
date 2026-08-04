import { afterEach, expect, it } from "vitest";
import { addReplacementLink, listReplacementLinksByVariant, listReplacementLinksForVariant, removeReplacementLink } from "../src/modules/nedostupne/replacement-links.js";
import { withCleanDb } from "./helpers/db.js";

// issue 238: majiteľove RUČNE vložené odkazy na náhradné produkty — nahrádza
// automatický `product.relatedCodes` návrh, ktorý majiteľ zamietol.

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

it("prázdny variant nemá žiadne odkazy", async () => {
  const db = await boot();
  expect(await listReplacementLinksForVariant(db, "NEZNAMY")).toEqual([]);
});

it("pridanie odkazu ho hneď sprístupní cez zoznam", async () => {
  const db = await boot();
  const link = await addReplacementLink(db, "R238A", "https://www.forestshop.sk/nahrada-a/", new Date("2026-08-04T10:00:00Z"));
  expect(link.url).toBe("https://www.forestshop.sk/nahrada-a/");

  const links = await listReplacementLinksForVariant(db, "R238A");
  expect(links).toEqual([{ id: link.id, url: "https://www.forestshop.sk/nahrada-a/" }]);
});

it("VIAC odkazov na ten istý variant — poradie podľa vloženia (najstarší prvý)", async () => {
  const db = await boot();
  await addReplacementLink(db, "R238B", "https://www.forestshop.sk/prvy/", new Date("2026-08-04T10:00:00Z"));
  await addReplacementLink(db, "R238B", "https://www.forestshop.sk/druhy/", new Date("2026-08-04T10:01:00Z"));

  const links = await listReplacementLinksForVariant(db, "R238B");
  expect(links.map((l) => l.url)).toEqual(["https://www.forestshop.sk/prvy/", "https://www.forestshop.sk/druhy/"]);
});

it("zoznam podľa viacerých variantov naraz zoskupí presne podľa kódu", async () => {
  const db = await boot();
  await addReplacementLink(db, "R238C1", "https://www.forestshop.sk/c1/", new Date("2026-08-04T10:00:00Z"));
  await addReplacementLink(db, "R238C2", "https://www.forestshop.sk/c2/", new Date("2026-08-04T10:00:00Z"));

  const map = await listReplacementLinksByVariant(db, ["R238C1", "R238C2", "R238C3"]);
  expect(map.get("R238C1")?.map((l) => l.url)).toEqual(["https://www.forestshop.sk/c1/"]);
  expect(map.get("R238C2")?.map((l) => l.url)).toEqual(["https://www.forestshop.sk/c2/"]);
  expect(map.has("R238C3")).toBe(false);
});

it("zmazanie odkazu ho odstráni zo zoznamu; zmazanie neznámeho id vráti false", async () => {
  const db = await boot();
  const link = await addReplacementLink(db, "R238D", "https://www.forestshop.sk/d/", new Date("2026-08-04T10:00:00Z"));

  expect(await removeReplacementLink(db, link.id)).toBe(true);
  expect(await listReplacementLinksForVariant(db, "R238D")).toEqual([]);
  expect(await removeReplacementLink(db, link.id)).toBe(false);
});
