import { expect, it, vi } from "vitest";
import {
  CatalogUnauthorizedError,
  fetchCatalogStats,
  searchCatalogVariants,
  triggerCatalogIngest,
} from "./catalogApi.js";

const STATS = {
  variantCount: 35,
  productCount: 8,
  sellable: 6,
  outOfStock: 4,
  discontinued: 25,
  missing: 0,
  lastSnapshot: {
    id: "s1",
    fetchedAt: "2026-07-29T10:00:00.000Z",
    sourceLabel: "fixtúra",
    verdict: "accepted",
    rejectionReason: null,
    rowCount: 35,
    byteSize: 92_000,
    columnCount: 265,
    variantCount: 35,
    productCount: 8,
    issueCount: 0,
  },
};

it("prečíta prehľad katalógu", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(STATS), { status: 200 })),
  );
  await expect(fetchCatalogStats()).resolves.toMatchObject({ variantCount: 35 });
});

it("odmietne prehľad s neplatným tvarom", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ variantCount: "veľa" }), { status: 200 })),
  );
  await expect(fetchCatalogStats()).rejects.toThrow();
});

it("zloží dopyt na hľadanie z parametrov", async () => {
  const spy = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 }));
  vi.stubGlobal("fetch", spy);

  await searchCatalogVariants({ q: "40237/3XL", state: "sellable", page: 2 });

  expect(spy).toHaveBeenCalledWith(
    "/api/catalog/variants?q=40237%2F3XL&state=sellable&page=2&pageSize=50",
  );
});

it("zlyhá zrozumiteľne pri chybe servera", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(searchCatalogVariants({ q: "", state: "all", page: 1 })).rejects.toThrow(
    "Katalóg sa nepodarilo načítať",
  );
});

it("pri 401 vyhodí CatalogUnauthorizedError namiesto všeobecnej chyby", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(fetchCatalogStats()).rejects.toBeInstanceOf(CatalogUnauthorizedError);
});

it("odovzdá hlásenie servera namiesto všeobecnej hlášky, keď ho server pošle", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)" }),
        { status: 503 },
      ),
    ),
  );
  await expect(triggerCatalogIngest()).rejects.toThrow(
    "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)",
  );
});

it("keď server nepošle telo s chybou, spustenie importu zlyhá so všeobecnou hláškou", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(triggerCatalogIngest()).rejects.toThrow("Import sa nepodarilo spustiť");
});

it("rozlíši každý výsledok importu vrátane 'busy', keď už jeden beží", async () => {
  const cases = [
    {
      status: "accepted",
      snapshotId: "s1",
      variantCount: 35,
      productCount: 8,
      missingCount: 0,
      issueCount: 2,
    },
    { status: "rejected", snapshotId: "s2", reason: "export je prázdny" },
    { status: "duplicate", snapshotId: "s3" },
    { status: "busy" },
  ] as const;

  for (const result of cases) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 })),
    );
    await expect(triggerCatalogIngest()).resolves.toEqual(result);
  }
});
