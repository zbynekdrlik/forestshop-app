// issue 598: shop-sitemap NESMIE každú noc 15 minút zbytočne chodiť po e-shope.
// Pred touto zmenou probe prechod skúšal každú noc TIE ISTÉ prvé produkty
// (deterministické poradie podľa productKey, žiadna pamäť pokusov), narazil na
// 15-min rozpočet a k zvyšku sa nikdy nedostal — PROD 21.–25. 10. 2026:
// `missingProducts: 1291`, `resolvedByProbe: 0`, 900 s každú noc, a od
// 21. 10. Shoptet WAF blokuje IP servera. Tieto testy overujú: zastavenie na
// prvom bloku, ochrannú dobu po neúspešnom pokuse, strop požiadaviek a poradie.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { products, shopProductUrl, shopSitemapProbeAttempt, variants } from "../src/db/schema.js";
import { ShoptetBlockedError } from "../src/modules/shoptet-http/blocked.js";
import { MIN_SITEMAP_LOCS, PROBE_COOLDOWN_DAYS } from "../src/modules/shop-sitemap/constants.js";
import { candidateSlugs } from "../src/modules/shop-sitemap/candidates.js";
import { runShopSitemap } from "../src/modules/shop-sitemap/run.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-10-26T03:05:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function sitemapWith(slugs: readonly string[]): string {
  const entries = slugs.map((s) => `<url><loc>https://www.forestshop.sk/${s}/</loc></url>`).join("");
  const filler = Array.from({ length: MIN_SITEMAP_LOCS }, (_unused, i) => `<url><loc>https://www.forestshop.sk/filler-${String(i)}/</loc></url>`).join("");
  return `<urlset>${entries}${filler}</urlset>`;
}

describe("runShopSitemap — šetrenie e-shopu (issue 598)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let snapshotId: string;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
    snapshotId = await insertTestSnapshot(db);
  });
  afterEach(async () => {
    await close();
  });

  const seedProduct = async (key: string, name: string, code: string): Promise<void> => {
    await db.insert(products).values({ key, name, supplier: null, internalNote: null, firstSeenAt: NOW, lastSeenAt: NOW, lastSeenSnapshotId: snapshotId });
    await db.insert(variants).values({
      code,
      productKey: key,
      guid: key,
      sizeLabel: null,
      name: `Variant ${code}`,
      stock: 0,
      availabilityInStockText: "",
      availabilityOutOfStockText: "",
      availabilityText: "",
      productVisibility: "visible",
      state: "sellable",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
  };

  it("bloková stránka Shoptetu → probe prechod sa zastaví HNEĎ, ďalší produkt sa už nesonduje, sitemap výsledky sa zapíšu", async () => {
    await seedProduct("p-1", "Bunda Forest", "S1"); // vyrieši sitemapa
    await seedProduct("p-2", "Prvy Neznamy", "P2");
    await seedProduct("p-3", "Druhy Neznamy", "P3");

    const probed: string[] = [];
    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith(["bunda-forest"])),
      fetchCandidate: (c) => {
        probed.push(c);
        if (probed.length === 2) return Promise.reject(new ShoptetBlockedError("sonda produktu"));
        return Promise.resolve(null);
      },
    });

    expect(result.stoppedReason).toBe("shoptet_blocked");
    expect(result.stoppedEarly).toBe(true);
    expect(result.probeRequests).toBe(2);
    // Druhý produkt (p-3) sa po bloku NIKDY nesonduje.
    expect(probed.every((c) => !c.includes("druhy"))).toBe(true);
    expect(result.resolvedBySitemap).toBe(1);
    const [row] = await db.select({ url: shopProductUrl.url }).from(shopProductUrl).where(eq(shopProductUrl.code, "S1"));
    expect(row?.url).toBe("https://www.forestshop.sk/bunda-forest/");
    // Produkt prerušený blokom sa NEZAPÍŠE ako „skúšaný" — dostane šancu znova.
    const attempts = await db.select().from(shopSitemapProbeAttempt);
    expect(attempts).toEqual([]);
  });

  it("produkt neúspešne skúšaný v ochrannej dobe sa NESONDUJE; starší pokus áno; neúspešný pokus sa zapíše s časom behu", async () => {
    await seedProduct("p-a", "Cerstvy Pokus", "A1");
    await seedProduct("p-b", "Stary Pokus", "B1");
    await seedProduct("p-c", "Nikdy Neskusany", "C1");
    await db.insert(shopSitemapProbeAttempt).values([
      { productKey: "p-a", attemptedAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { productKey: "p-b", attemptedAt: new Date(NOW.getTime() - (PROBE_COOLDOWN_DAYS + 1) * DAY_MS) },
    ]);

    const probed: string[] = [];
    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith([])),
      fetchCandidate: (c) => {
        probed.push(c);
        return Promise.resolve(null);
      },
    });

    expect(result.skippedCooldown).toBe(1);
    expect(result.probedProducts).toBe(2);
    expect(probed.some((c) => c.includes("cerstvy-pokus"))).toBe(false);
    expect(probed.some((c) => c.includes("stary-pokus"))).toBe(true);
    expect(probed.some((c) => c.includes("nikdy-neskusany"))).toBe(true);
    // Poradie: najprv NIKDY neskúšaný, potom najdávnejšie skúšaný.
    const firstNever = probed.findIndex((c) => c.includes("nikdy-neskusany"));
    const firstOld = probed.findIndex((c) => c.includes("stary-pokus"));
    expect(firstNever).toBeLessThan(firstOld);
    expect(result.stoppedReason).toBeNull();

    const attempts = await db.select().from(shopSitemapProbeAttempt);
    const byKey = new Map(attempts.map((a) => [a.productKey, a.attemptedAt.getTime()]));
    expect(byKey.get("p-b")).toBe(NOW.getTime());
    expect(byKey.get("p-c")).toBe(NOW.getTime());
    // Pokus v ochrannej dobe ostáva bezo zmeny.
    expect(byKey.get("p-a")).toBe(NOW.getTime() - 2 * DAY_MS);
  });

  it("strop požiadaviek na beh: produkt, ktorého kandidáti by strop prekročili, sa už nezačne", async () => {
    await seedProduct("p-1", "Prvy Produkt", "X1");
    await seedProduct("p-2", "Druhy Produkt", "X2");
    const perProduct = candidateSlugs("Prvy Produkt").length;

    let calls = 0;
    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith([])),
      fetchCandidate: () => {
        calls += 1;
        return Promise.resolve(null);
      },
      maxProbeRequests: perProduct + 1,
    });

    expect(calls).toBe(perProduct);
    expect(result.probeRequests).toBe(perProduct);
    expect(result.probedProducts).toBe(1);
    expect(result.stoppedReason).toBe("request_cap");
    expect(result.stoppedEarly).toBe(true);
  });

  it("vyriešený produkt (probe trafil) sa do pamäte pokusov NEZAPÍŠE — má už svoj riadok", async () => {
    await seedProduct("p-ok", "Trafeny Produkt", "T1");
    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith([])),
      fetchCandidate: (c) => Promise.resolve(c === "trafeny-produkt" ? "https://www.forestshop.sk/trafeny-produkt/" : null),
    });
    expect(result.resolvedByProbe).toBe(1);
    expect(await db.select().from(shopSitemapProbeAttempt)).toEqual([]);
  });
});
