import { describe, expect, it } from "vitest";
import { computeStatus, isActionableNow } from "./status.js";

const NOW = new Date("2026-08-05T08:00:00Z");

describe("computeStatus", () => {
  it("vybavené má prednosť pred všetkým ostatným", () => {
    expect(
      computeStatus({ seenAt: null, postponedUntil: new Date("2099-01-01T00:00:00Z"), resolvedAt: NOW }, NOW),
    ).toBe("vybavene");
  });

  it("odložené do BUDÚCNOSTI je 'odlozene', aj keď je nevidené", () => {
    expect(
      computeStatus({ seenAt: null, postponedUntil: new Date("2026-08-10T00:00:00Z"), resolvedAt: null }, NOW),
    ).toBe("odlozene");
  });

  it("odložené do MINULOSTI (dátum návratu prešiel) sa už NEPOČÍTA ako odložené", () => {
    expect(
      computeStatus({ seenAt: NOW, postponedUntil: new Date("2026-08-01T00:00:00Z"), resolvedAt: null }, NOW),
    ).toBe("otvorene");
  });

  it("nevidené bez odloženia je 'nove'", () => {
    expect(computeStatus({ seenAt: null, postponedUntil: null, resolvedAt: null }, NOW)).toBe("nove");
  });

  it("videné, nevyriešené, neodložené je 'otvorene'", () => {
    expect(computeStatus({ seenAt: NOW, postponedUntil: null, resolvedAt: null }, NOW)).toBe("otvorene");
  });

  it("presne v momente návratu (postponedUntil === now) sa už vracia — hranica patrí NÁVRATU, nie odloženiu", () => {
    expect(computeStatus({ seenAt: NOW, postponedUntil: NOW, resolvedAt: null }, NOW)).toBe("otvorene");
  });
});

describe("isActionableNow", () => {
  it("nové aj otvorené sú akčné", () => {
    expect(isActionableNow({ seenAt: null, postponedUntil: null, resolvedAt: null }, NOW)).toBe(true);
    expect(isActionableNow({ seenAt: NOW, postponedUntil: null, resolvedAt: null }, NOW)).toBe(true);
  });

  it("odložené (do budúcnosti) NIE JE akčné — zmizne z odznaku, kým sa nevráti", () => {
    expect(
      isActionableNow({ seenAt: NOW, postponedUntil: new Date("2099-01-01T00:00:00Z"), resolvedAt: null }, NOW),
    ).toBe(false);
  });

  it("vybavené NIE JE akčné", () => {
    expect(isActionableNow({ seenAt: NOW, postponedUntil: null, resolvedAt: NOW }, NOW)).toBe(false);
  });
});
