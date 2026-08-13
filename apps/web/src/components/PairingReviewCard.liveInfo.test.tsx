import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PairingReviewCard } from "./PairingReviewCard.js";

// issue 422 — vyčlenené OD `PairingReviewCard.test.tsx` (eslint `max-lines:
// 400`, `.claude/rules/testing.md`'s zavedený vzor "component/test file
// that grows past the cap gets a thematically-coherent block extracted
// into its own file", napr. `orders-http.integration.test.ts`/`orders-
// http-state.integration.test.ts`): 🤖 AI zdôvodnenie zhody (gap 1) + "naša
// strana" cena/sklad/dostupnosť (gap 2, persistované) + živá cena/
// dostupnosť dodávateľa (gap 2, lazy-fetch cez `useLiveSupplierInfo`,
// mockovaná cez `fetchLiveSupplierInfo`).

const { fetchPairingCandidates, sendPairingDecision, fetchPairingVariantLinks, savePairingVariantLink, fetchLiveSupplierInfo } = vi.hoisted(() => ({
  fetchPairingCandidates: vi.fn(),
  sendPairingDecision: vi.fn(),
  fetchPairingVariantLinks: vi.fn(),
  savePairingVariantLink: vi.fn(),
  fetchLiveSupplierInfo: vi.fn(),
}));

vi.mock("../pairingReviewApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pairingReviewApi.js")>();
  return { ...actual, fetchPairingCandidates, sendPairingDecision, fetchPairingVariantLinks, savePairingVariantLink, fetchLiveSupplierInfo };
});

const MATCHED_ITEM = {
  productKey: "PR-LI-1",
  productName: "Bunda Alfa Zimná",
  supplier: "DODAVATEL-PR",
  externalCodes: ["KOD-123"],
  variantCount: 2,
  productState: "sellable" as const,
  priceMin: "59.90",
  priceMax: "64.90",
  currency: "EUR",
  standardPriceMin: "59.90",
  standardPriceMax: "64.90",
  stockTotal: 0,
  availabilityText: null,
  ourUrl: "https://www.forestshop.sk/bunda-alfa",
  ourUrlIsSearchFallback: false,
  ourImageUrl: "https://www.forestshop.sk/img/bunda.jpg",
  hasEffectiveLink: false,
  supplierHasAdapter: true,
  gatheredAt: "2026-08-13T03:35:00.000Z",
  confidence: "high" as const,
  chosenReason: "najlepší nájdený",
  verdict: "ok" as const,
  chosenCandidate: {
    name: "Bunda Alfa",
    url: "https://dodavatel.example.com/bunda-alfa",
    imageUrl: "https://dodavatel.example.com/img/bunda-alfa.jpg",
    rawScore: 1080.5,
    codeHit: true,
  },
  decision: null,
};

const UNMATCHED_ITEM = { ...MATCHED_ITEM, productKey: "PR-LI-2", chosenCandidate: null, confidence: "none" as const, verdict: null };

beforeEach(() => {
  fetchLiveSupplierInfo.mockResolvedValue({ price: null, availabilityText: null });
  // UNMATCHED_ITEM (chosenCandidate === null) auto-otvára panel kandidátov
  // (`PairingReviewCard.tsx`'s `autoShowsPanel` useEffect) — bez tohto by
  // `fetchPairingCandidates(...)` vrátilo `undefined` (holý `vi.fn()`) a
  // `.then()` naň by zhodilo test (rovnaký vzor ako `PairingReviewCard
  // .test.tsx`'s existujúce testy nad nenapárovanými položkami).
  fetchPairingCandidates.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("chosenReason !== null pri navrhnutom kandidátovi -> zobrazí '🤖 <reason>'", async () => {
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  expect((await screen.findByTestId("pairing-review-reason-PR-LI-1")).textContent).toBe("🤖 najlepší nájdený");
});

it("chosenCandidate === null (nenapárované) -> ŽIADNY '🤖' riadok, aj keby chosenReason nejako niesol hodnotu", async () => {
  // Štrukturálne chosenReason je pre nenapárované VŽDY null (design komentár
  // na tickete #422), ale komponent to overuje explicitne cez podmienku na
  // chosenCandidate, nie len na chosenReason — tento test to dokazuje
  // priamo aj pri (neplatnom, ale teoreticky možnom) nesúlade dát.
  const item = { ...UNMATCHED_ITEM, chosenReason: "toto sa v appke reálne nikdy nestane" };
  render(<PairingReviewCard item={item} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-card-PR-LI-2");
  expect(screen.queryByTestId("pairing-review-reason-PR-LI-2")).toBeNull();
});

it("chosenReason === null pri navrhnutom kandidátovi -> žiadny '🤖' riadok", async () => {
  const item = { ...MATCHED_ITEM, chosenReason: null };
  render(<PairingReviewCard item={item} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-candidate-PR-LI-1");
  expect(screen.queryByTestId("pairing-review-reason-PR-LI-1")).toBeNull();
});

it("'naša strana': standardPriceMin/Max sa líši od priceMin/Max -> ukáže 'pôv. X–Y €'; stockTotal>0 + availabilityText -> ukáže sklad+text", async () => {
  const item = { ...MATCHED_ITEM, standardPriceMin: "69.90", standardPriceMax: "74.90", stockTotal: 4, availabilityText: "Skladom" };
  render(<PairingReviewCard item={item} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  const karta = await screen.findByTestId("pairing-review-card-PR-LI-1");
  expect(karta.textContent).toContain("pôv. 69.90–74.90 €");
  expect(screen.getByTestId("pairing-review-stock-PR-LI-1").textContent).toContain("sklad: 4 ks");
  expect(screen.getByTestId("pairing-review-stock-PR-LI-1").textContent).toContain("Skladom");
});

it("'naša strana': standardPriceMin/Max ROVNAKÉ ako priceMin/Max (žiadna zľava) -> 'pôv.' sa NEUKÁŽE", async () => {
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  const karta = await screen.findByTestId("pairing-review-card-PR-LI-1");
  expect(karta.textContent).not.toContain("pôv.");
});

it("'naša strana': stockTotal===0 A availabilityText===null -> ŽIADEN sklad riadok vôbec", async () => {
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-card-PR-LI-1");
  expect(screen.queryByTestId("pairing-review-stock-PR-LI-1")).toBeNull();
});

it("živá cena/dostupnosť dodávateľa: fetchLiveSupplierInfo vráti hodnotu -> zobrazí sa vedľa navrhnutého kandidáta, s VOLANÍM presnej candidate URL", async () => {
  fetchLiveSupplierInfo.mockResolvedValue({ price: "54.90", availabilityText: "Skladom" });
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  const liveInfo = await screen.findByTestId("pairing-review-live-info-PR-LI-1");
  expect(liveInfo.textContent).toContain("54.90 €");
  expect(liveInfo.textContent).toContain("Skladom");
  expect(fetchLiveSupplierInfo).toHaveBeenCalledWith("https://dodavatel.example.com/bunda-alfa");
});

it("živá cena/dostupnosť dodávateľa: fetchLiveSupplierInfo vráti null/null (tichá degradácia) -> ŽIADEN riadok, žiadna chyba", async () => {
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-candidate-PR-LI-1");
  await waitFor(() => {
    expect(fetchLiveSupplierInfo).toHaveBeenCalled();
  });
  expect(screen.queryByTestId("pairing-review-live-info-PR-LI-1")).toBeNull();
});

it("chosenCandidate === null -> fetchLiveSupplierInfo sa VÔBEC nevolá (žiadna URL na fetchnutie)", async () => {
  render(<PairingReviewCard item={UNMATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-card-PR-LI-2");
  expect(fetchLiveSupplierInfo).not.toHaveBeenCalled();
});
