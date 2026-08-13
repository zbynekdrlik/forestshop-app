import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingReviewSection } from "./PairingReviewSection.js";

const { searchPairingReview } = vi.hoisted(() => ({ searchPairingReview: vi.fn() }));

// `PairingReviewUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `RestockLinkSuggestionsSection.test.tsx`/`NedostupneSection.test.tsx` —
// `instanceof` v komponente musí fungovať aj v teste).
vi.mock("../pairingReviewApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pairingReviewApi.js")>();
  return { ...actual, searchPairingReview };
});

const { PairingReviewUnauthorizedError } = await import("../pairingReviewApi.js");

const MATCHED_ITEM = {
  productKey: "PR-1",
  productName: "Bunda Alfa Zimná",
  supplier: "DODAVATEL-PR",
  externalCodes: ["KOD-123"],
  variantCount: 2,
  productState: "sellable" as const,
  priceMin: "59.90",
  priceMax: "64.90",
  currency: "EUR",
  ourUrl: "https://www.forestshop.sk/bunda-alfa",
  ourImageUrl: "https://www.forestshop.sk/img/bunda.jpg",
  hasEffectiveLink: false,
  gatheredAt: "2026-08-13T03:35:00.000Z",
  confidence: "high" as const,
  chosenReason: "najlepší nájdený",
  verdict: "ok" as const,
  chosenCandidate: { name: "Bunda Alfa", url: "https://dodavatel.example.com/bunda-alfa", rawScore: 1080.5, codeHit: true },
  decision: null,
};

const UNMATCHED_ITEM = {
  productKey: "PR-2",
  productName: "Produkt bez kandidáta",
  supplier: null,
  externalCodes: [],
  variantCount: 1,
  productState: "out_of_stock" as const,
  priceMin: null,
  priceMax: null,
  currency: null,
  ourUrl: "https://www.forestshop.sk/vyhladavanie/?string=Produkt%20bez%20kandid%C3%A1ta",
  ourImageUrl: null,
  hasEffectiveLink: false,
  gatheredAt: "2026-08-13T03:35:00.000Z",
  confidence: "none" as const,
  chosenReason: null,
  verdict: null,
  chosenCandidate: null,
  decision: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it("zobrazí karty pre napárovaný aj nenapárovaný produkt s progress počítadlom", async () => {
  searchPairingReview.mockResolvedValue({ total: 2, gatheredTotal: 5, linkedTotal: 3, items: [MATCHED_ITEM, UNMATCHED_ITEM] });

  render(<PairingReviewSection role="citanie" onSessionExpired={() => {}} />);

  const matchedCard = await screen.findByTestId("pairing-review-card-PR-1");
  expect(matchedCard.textContent).toContain("Bunda Alfa Zimná");
  expect(matchedCard.textContent).toContain("Bunda Alfa");
  expect(screen.getByTestId("pairing-review-verdict-PR-1").textContent).toContain("overený");

  const unmatchedCard = screen.getByTestId("pairing-review-card-PR-2");
  expect(unmatchedCard.textContent).toContain("Produkt bez kandidáta");
  expect(screen.getByTestId("pairing-review-no-candidate-PR-2")).toBeDefined();

  expect(screen.getByTestId("pairing-review-progress").textContent).toContain("3 / 5 s odkazom");
});

it("keď zoznam nezodpovedá žiadnemu produktu, zobrazí informačnú vetu", async () => {
  searchPairingReview.mockResolvedValue({ total: 0, gatheredTotal: 0, linkedTotal: 0, items: [] });

  render(<PairingReviewSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("pairing-review-empty");
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  searchPairingReview.mockRejectedValue(new PairingReviewUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<PairingReviewSection role="citanie" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

// Default filter je "unreviewed" (design komentár na tickete, issue 387 E5) —
// prvé volanie po mounte MUSÍ toto poslať, aj bez akéhokoľvek predošlého
// localStorage záznamu.
it("predvolený filter pri prvom otvorení je 'unreviewed'", async () => {
  searchPairingReview.mockResolvedValue({ total: 0, gatheredTotal: 0, linkedTotal: 0, items: [] });

  render(<PairingReviewSection role="citanie" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(searchPairingReview).toHaveBeenCalledWith({ filter: "unreviewed", page: 1 });
  });
});

it("klik na iný filter znova načíta zoznam s novým filtrom a zapamätá si ho do localStorage", async () => {
  searchPairingReview.mockResolvedValue({ total: 0, gatheredTotal: 0, linkedTotal: 0, items: [] });

  render(<PairingReviewSection role="citanie" onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-empty");

  searchPairingReview.mockClear();
  searchPairingReview.mockResolvedValue({ total: 1, gatheredTotal: 4, linkedTotal: 4, items: [MATCHED_ITEM] });

  screen.getByTestId("pairing-review-filter-matched").click();

  await waitFor(() => {
    expect(searchPairingReview).toHaveBeenCalledWith({ filter: "matched", page: 1 });
  });
  expect(window.localStorage.getItem("pairingReviewFilter")).toBe("matched");
});

// Substring kolízia s "Párovanie produktov" (#239) — pozri design komentár
// na tickete: `getByRole` musí byť `exact: true`, inak by zasiahol OBE
// záložky. Tento test dokazuje, že karta samotná (nie navigácia) NEPOUŽÍVA
// zdieľaný nejednoznačný accessible name.
it("hlavička karty 'Náš produkt' je odlíšená od 'Navrhnutý kandidát' — bez vlastného <h1>/<h2> obrazovky", async () => {
  searchPairingReview.mockResolvedValue({ total: 1, gatheredTotal: 1, linkedTotal: 0, items: [MATCHED_ITEM] });

  render(<PairingReviewSection role="citanie" onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-card-PR-1");

  expect(screen.queryByRole("heading")).toBeNull();
});
