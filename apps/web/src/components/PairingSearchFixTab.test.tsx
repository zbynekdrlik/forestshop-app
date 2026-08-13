import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingSearchFixTab } from "./PairingSearchFixTab.js";

// issue 399 — "Hľadať / opraviť" pod-záložka: vyhľadávacie pole (zdieľané
// `GET /api/search`) + jednoproduktová karta (zdieľaný `PairingReviewCard.tsx`,
// nová `fetchPairingReviewItem`). Rovnaký mock vzor ako `PairingReviewCard
// .test.tsx`/`SearchSection.tsx` — obe moduly namockované naraz, lebo
// `PairingReviewCard` (vykreslený z tohto komponentu po otvorení produktu)
// importuje z `pairingReviewApi.js` nezávisle.

const { globalSearch, fetchPairingReviewItem, fetchPairingCandidates, sendPairingDecision } = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  fetchPairingReviewItem: vi.fn(),
  fetchPairingCandidates: vi.fn(),
  sendPairingDecision: vi.fn(),
}));

vi.mock("../searchApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../searchApi.js")>();
  return { ...actual, globalSearch };
});
vi.mock("../pairingReviewApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pairingReviewApi.js")>();
  return { ...actual, fetchPairingReviewItem, fetchPairingCandidates, sendPairingDecision };
});

const { SearchUnauthorizedError } = await import("../searchApi.js");
const { PairingReviewUnauthorizedError } = await import("../pairingReviewApi.js");

const HIT_A_SIZE_S = {
  productKey: "PR-A",
  variantCode: "PR-A/S",
  productName: "Bunda Alfa",
  sizeLabel: "S",
  supplier: "DODAVATEL-A",
  externalCode: null,
  state: "sellable" as const,
};
const HIT_A_SIZE_M = { ...HIT_A_SIZE_S, variantCode: "PR-A/M", sizeLabel: "M" };
const HIT_B = {
  productKey: "PR-B",
  variantCode: "PR-B",
  productName: "Čiapka Beta",
  sizeLabel: null,
  supplier: null,
  externalCode: "EXT-1",
  state: "out_of_stock" as const,
};

const ITEM_A = {
  productKey: "PR-A",
  productName: "Bunda Alfa",
  supplier: "DODAVATEL-A",
  externalCodes: [],
  variantCount: 2,
  productState: "sellable" as const,
  priceMin: null,
  priceMax: null,
  currency: null,
  ourUrl: "https://www.forestshop.sk/bunda-alfa",
  ourUrlIsSearchFallback: false,
  ourImageUrl: null,
  hasEffectiveLink: true,
  supplierHasAdapter: false,
  gatheredAt: null,
  confidence: "none" as const,
  chosenReason: null,
  verdict: null,
  chosenCandidate: null,
  decision: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function search(q: string): void {
  fireEvent.change(screen.getByLabelText("Kód, názov alebo dodávateľ"), { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: "Hľadať" }));
}

it("výsledky sa DEDUPUJÚ podľa productKey — dva varianty toho istého produktu ukážu JEDEN riadok", async () => {
  globalSearch.mockResolvedValue({ products: [HIT_A_SIZE_S, HIT_A_SIZE_M, HIT_B], orders: [] });
  render(<PairingSearchFixTab role="manazer" onSessionExpired={() => {}} />);

  search("bunda");

  await waitFor(() => {
    expect(screen.getByTestId("pairing-search-fix-row-PR-A")).toBeDefined();
  });
  expect(screen.getByTestId("pairing-search-fix-row-PR-B")).toBeDefined();
  expect(screen.queryAllByTestId(/pairing-search-fix-row-PR-A/)).toHaveLength(1);
});

it("žiadne výsledky ukážu 'Nič sa nenašlo.'", async () => {
  globalSearch.mockResolvedValue({ products: [], orders: [] });
  render(<PairingSearchFixTab role="manazer" onSessionExpired={() => {}} />);

  search("neexistuje");
  expect(await screen.findByTestId("pairing-search-fix-empty")).toBeDefined();
});

it("klik na 'Otvoriť' nájde produkt cez fetchPairingReviewItem a vykreslí PairingReviewCard", async () => {
  globalSearch.mockResolvedValue({ products: [HIT_A_SIZE_S], orders: [] });
  fetchPairingReviewItem.mockResolvedValue(ITEM_A);
  fetchPairingCandidates.mockResolvedValue([]);
  render(<PairingSearchFixTab role="manazer" onSessionExpired={() => {}} />);

  search("alfa");
  fireEvent.click(await screen.findByTestId("pairing-search-fix-open-PR-A"));

  await waitFor(() => {
    expect(fetchPairingReviewItem).toHaveBeenCalledWith("PR-A");
  });
  expect(await screen.findByTestId("pairing-review-card-PR-A")).toBeDefined();
});

it("neznámy productKey (404 -> null) ukáže 'Produkt sa nenašiel.'", async () => {
  globalSearch.mockResolvedValue({ products: [HIT_A_SIZE_S], orders: [] });
  fetchPairingReviewItem.mockResolvedValue(null);
  render(<PairingSearchFixTab role="manazer" onSessionExpired={() => {}} />);

  search("alfa");
  fireEvent.click(await screen.findByTestId("pairing-search-fix-open-PR-A"));

  expect(await screen.findByTestId("pairing-search-fix-notfound")).toBeDefined();
});

it("'← Späť na výsledky' sa vráti na predošlé výsledky bez nového vyhľadávania", async () => {
  globalSearch.mockResolvedValue({ products: [HIT_A_SIZE_S], orders: [] });
  fetchPairingReviewItem.mockResolvedValue(ITEM_A);
  fetchPairingCandidates.mockResolvedValue([]);
  render(<PairingSearchFixTab role="manazer" onSessionExpired={() => {}} />);

  search("alfa");
  fireEvent.click(await screen.findByTestId("pairing-search-fix-open-PR-A"));
  await screen.findByTestId("pairing-review-card-PR-A");

  fireEvent.click(screen.getByTestId("pairing-search-fix-back"));
  expect(screen.getByTestId("pairing-search-fix-row-PR-A")).toBeDefined();
  expect(globalSearch).toHaveBeenCalledTimes(1); // žiadne ĎALŠIE vyhľadávanie
});

it("401 pri vyhľadávaní zavolá onSessionExpired", async () => {
  globalSearch.mockRejectedValue(new SearchUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<PairingSearchFixTab role="manazer" onSessionExpired={onSessionExpired} />);

  search("čokoľvek");
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("401 pri otváraní produktu zavolá onSessionExpired", async () => {
  globalSearch.mockResolvedValue({ products: [HIT_A_SIZE_S], orders: [] });
  fetchPairingReviewItem.mockRejectedValue(new PairingReviewUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<PairingSearchFixTab role="manazer" onSessionExpired={onSessionExpired} />);

  search("alfa");
  fireEvent.click(await screen.findByTestId("pairing-search-fix-open-PR-A"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
