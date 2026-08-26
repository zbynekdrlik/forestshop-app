import { describe, expect, it } from "vitest";
import { createSingleUsePreviewTokenStore } from "./single-use-preview-tokens.js";

// issue 505: priamy unit test zdieľaného jadra jednorazových preview-tokenov
// (tri tenké wrappery — nedostupne/order-merge/customer-contact — ho volajú
// cez svoje serializované kľúče a majú vlastné testy). Overuje generický
// kontrakt store-u: jednorazovosť, viazanie na kľúč, TTL a izoláciu inštancií.
const NOW = new Date("2026-08-26T10:00:00Z");

describe("createSingleUsePreviewTokenStore", () => {
  it("token vydaný pre presne tento kľúč sa dá skonzumovať PRESNE raz", () => {
    const store = createSingleUsePreviewTokenStore();
    const token = store.issue("k1", NOW);
    expect(store.consume(token, "k1", NOW)).toBe(true);
    expect(store.consume(token, "k1", NOW)).toBe(false);
  });

  it("token vydaný pre INÝ kľúč sa nedá použiť na iný consume", () => {
    const store = createSingleUsePreviewTokenStore();
    const token = store.issue("k1", NOW);
    expect(store.consume(token, "k2", NOW)).toBe(false);
  });

  it("neznámy/vymyslený token je vždy neplatný", () => {
    const store = createSingleUsePreviewTokenStore();
    expect(store.consume("vymyslený-token", "k1", NOW)).toBe(false);
  });

  it("nezhodný pokus token AJ TAK skonzumuje (jednorazový, bez ohľadu na výsledok)", () => {
    const store = createSingleUsePreviewTokenStore();
    const token = store.issue("k1", NOW);
    expect(store.consume(token, "iný-kľúč", NOW)).toBe(false);
    // Druhý pokus so SPRÁVNYM kľúčom už zlyhá — token bol zničený prvým
    // (nesprávnym) pokusom.
    expect(store.consume(token, "k1", NOW)).toBe(false);
  });

  it("token po TOKEN_TTL_MS (15 minút) exspiruje", () => {
    const store = createSingleUsePreviewTokenStore();
    const token = store.issue("k1", NOW);
    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    expect(store.consume(token, "k1", later)).toBe(false);
  });

  it("dva nezávislé kľúče dostanú DVA rôzne tokeny, oba platné", () => {
    const store = createSingleUsePreviewTokenStore();
    const tokenA = store.issue("kA", NOW);
    const tokenB = store.issue("kB", NOW);
    expect(tokenA).not.toBe(tokenB);
    expect(store.consume(tokenA, "kA", NOW)).toBe(true);
    expect(store.consume(tokenB, "kB", NOW)).toBe(true);
  });

  it("dve nezávislé inštancie store majú oddelené tokeny (žiadny zdieľaný stav)", () => {
    const storeA = createSingleUsePreviewTokenStore();
    const storeB = createSingleUsePreviewTokenStore();
    const token = storeA.issue("k1", NOW);
    // Ten istý token v druhom store neexistuje — Map je per-inštancia.
    expect(storeB.consume(token, "k1", NOW)).toBe(false);
    // A v pôvodnom store stále platí (druhý store ho neskonzumoval).
    expect(storeA.consume(token, "k1", NOW)).toBe(true);
  });
});
