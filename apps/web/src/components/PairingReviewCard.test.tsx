import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingReviewCard } from "./PairingReviewCard.js";

// issue 387 E6 — rozhodovacia UX karty (`.claude/rules/frontend-design.md`'s
// toggle-open panel vzor). Vyčlenené OD `PairingReviewSection.test.tsx` (E5,
// list-rendering), rovnaký princíp ako `OrderLineRow.*.test.tsx`/
// `UpozornenieCard.*.test.ts` — karta má VLASTNÝ test súbor.

const { fetchPairingCandidates, sendPairingDecision } = vi.hoisted(() => ({
  fetchPairingCandidates: vi.fn(),
  sendPairingDecision: vi.fn(),
}));

// `PairingReviewUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `PairingReviewSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../pairingReviewApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pairingReviewApi.js")>();
  return { ...actual, fetchPairingCandidates, sendPairingDecision };
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
  chosenCandidate: {
    name: "Bunda Alfa",
    url: "https://dodavatel.example.com/bunda-alfa",
    imageUrl: "https://dodavatel.example.com/img/bunda-alfa.jpg",
    rawScore: 1080.5,
    codeHit: true,
  },
  decision: null,
};

const UNMATCHED_ITEM = {
  ...MATCHED_ITEM,
  productKey: "PR-2",
  chosenCandidate: null,
  confidence: "none" as const,
  verdict: null,
};

const DECIDED_UNAVAILABLE_ITEM = {
  ...MATCHED_ITEM,
  productKey: "PR-3",
  decision: { status: "unavailable" as const, url: null, decidedAt: "2026-08-13T04:00:00.000Z" },
};

const DECIDED_GOOD_ITEM = {
  ...MATCHED_ITEM,
  productKey: "PR-4",
  hasEffectiveLink: true,
  decision: { status: "good" as const, url: "https://dodavatel.example.com/bunda-alfa", decidedAt: "2026-08-13T04:00:00.000Z" },
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("'citanie' rola nevidí ŽIADNE akčné tlačidlo", async () => {
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  const card = await screen.findByTestId("pairing-review-card-PR-1");
  expect(card.querySelectorAll("button")).toHaveLength(0);
});

it("napárovaný produkt bez rozhodnutia ukáže ✓ Dobré / ✗ Zlé; klik na ✓ Dobré odošle {status:'good'} a zavolá onDecided", async () => {
  sendPairingDecision.mockResolvedValue(undefined);
  const onDecided = vi.fn();
  render(<PairingReviewCard item={MATCHED_ITEM} role="manazer" onDecided={onDecided} onSessionExpired={() => {}} />);

  expect(screen.getByTestId("pairing-review-good-PR-1")).toBeDefined();
  fireEvent.click(screen.getByTestId("pairing-review-good-PR-1"));

  await waitFor(() => {
    expect(sendPairingDecision).toHaveBeenCalledWith("PR-1", { status: "good" });
  });
  await waitFor(() => {
    expect(onDecided).toHaveBeenCalledTimes(1);
  });
});

it("issue 397: karta ukazuje obrázok kandidáta AJ nášho produktu vedľa seba; chýbajúci obrázok kandidáta ukáže 'bez obrázka'", async () => {
  render(<PairingReviewCard item={MATCHED_ITEM} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  const card = await screen.findByTestId("pairing-review-card-PR-1");
  const images = card.querySelectorAll("img");
  expect(images).toHaveLength(2);
  expect(images[0]?.getAttribute("src")).toBe(MATCHED_ITEM.ourImageUrl);
  expect(images[1]?.getAttribute("src")).toBe(MATCHED_ITEM.chosenCandidate.imageUrl);

  cleanup();
  const bezObrazka = { ...MATCHED_ITEM, productKey: "PR-NOIMG", chosenCandidate: { ...MATCHED_ITEM.chosenCandidate, imageUrl: null } };
  render(<PairingReviewCard item={bezObrazka} role="citanie" onDecided={() => {}} onSessionExpired={() => {}} />);
  const cardBezObrazka = await screen.findByTestId("pairing-review-card-PR-NOIMG");
  expect(cardBezObrazka.querySelectorAll("img")).toHaveLength(1); // len naša strana
  expect(cardBezObrazka.querySelectorAll(".pairing-review-noimg")).toHaveLength(1);
});

it("klik na ✗ Zlé ROZBALÍ panel NA MIESTE (karta ostáva) a načíta kandidátov; 'Vybrať' odošle manual s URL toho kandidáta", async () => {
  fetchPairingCandidates.mockResolvedValue([
    { name: "Top kandidát", url: "https://dodavatel.example.com/top", rawScore: 90, codeHit: true },
    { name: "Druhý kandidát", url: "https://dodavatel.example.com/druhy", rawScore: 60, codeHit: false },
  ]);
  sendPairingDecision.mockResolvedValue(undefined);

  render(<PairingReviewCard item={MATCHED_ITEM} role="manazer" onDecided={() => {}} onSessionExpired={() => {}} />);
  fireEvent.click(screen.getByTestId("pairing-review-open-panel-PR-1"));

  // Karta samotná sa NEPRESÚVA/nezmizne — panel sa objaví NA TEJ ISTEJ karte.
  expect(screen.getByTestId("pairing-review-card-PR-1")).toBeDefined();
  const panel = await screen.findByTestId("pairing-review-panel-PR-1");
  expect(panel.textContent).toContain("Top kandidát");
  expect(panel.textContent).toContain("Druhý kandidát");

  fireEvent.click(screen.getByTestId("pairing-review-panel-pick-PR-1-1"));
  await waitFor(() => {
    expect(sendPairingDecision).toHaveBeenCalledWith("PR-1", { status: "manual", url: "https://dodavatel.example.com/druhy" });
  });
});

it("ručná URL: neplatná adresa sa NEODOŠLE (klientská validácia), platná sa odošle orezaná", async () => {
  fetchPairingCandidates.mockResolvedValue([]);
  sendPairingDecision.mockResolvedValue(undefined);

  render(<PairingReviewCard item={UNMATCHED_ITEM} role="manazer" onDecided={() => {}} onSessionExpired={() => {}} />);
  // UNMATCHED_ITEM (bez chosenCandidate, bez rozhodnutia) ukazuje panel PRIAMO.
  const input = await screen.findByTestId("pairing-review-manual-input-PR-2");

  fireEvent.change(input, { target: { value: "nie-je-url" } });
  fireEvent.click(screen.getByTestId("pairing-review-manual-save-PR-2"));
  expect(sendPairingDecision).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("http");

  fireEvent.change(input, { target: { value: "  https://dodavatel.example.com/rucne  " } });
  fireEvent.click(screen.getByTestId("pairing-review-manual-save-PR-2"));
  await waitFor(() => {
    expect(sendPairingDecision).toHaveBeenCalledWith("PR-2", { status: "manual", url: "https://dodavatel.example.com/rucne" });
  });
});

it("📦 Nie je skladom / 🚫 Už sa nebude predávať odošlú príslušný terminálny status", async () => {
  fetchPairingCandidates.mockResolvedValue([]);
  sendPairingDecision.mockResolvedValue(undefined);

  render(<PairingReviewCard item={UNMATCHED_ITEM} role="manazer" onDecided={() => {}} onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-review-panel-PR-2");

  fireEvent.click(screen.getByTestId("pairing-review-unavailable-PR-2"));
  await waitFor(() => {
    expect(sendPairingDecision).toHaveBeenCalledWith("PR-2", { status: "unavailable" });
  });
});

it("už rozhodnutý produkt (terminálny stav) ukáže odznak + '↩ Vrátiť'; klik odošle {status:'revert'}", async () => {
  sendPairingDecision.mockResolvedValue(undefined);
  const onDecided = vi.fn();
  render(<PairingReviewCard item={DECIDED_UNAVAILABLE_ITEM} role="manazer" onDecided={onDecided} onSessionExpired={() => {}} />);

  expect(screen.getByTestId("pairing-review-decision-badge-PR-3").textContent).toContain("Nie je skladom");
  // Terminálny stav (unavailable/discontinued) nemá "Zmeniť" tlačidlo —
  // len napárované/manuálne rozhodnutia sa dajú "zmeniť na iný link".
  expect(screen.queryByTestId("pairing-review-change-PR-3")).toBeNull();

  fireEvent.click(screen.getByTestId("pairing-review-revert-PR-3"));
  await waitFor(() => {
    expect(sendPairingDecision).toHaveBeenCalledWith("PR-3", { status: "revert" });
  });
  await waitFor(() => {
    expect(onDecided).toHaveBeenCalledTimes(1);
  });
});

it("rozhodnutie 'good' ukáže AJ '✗ Zmeniť / iný link' — klik otvorí panel s kandidátmi", async () => {
  fetchPairingCandidates.mockResolvedValue([{ name: "Top kandidát", url: "https://dodavatel.example.com/bunda-alfa", rawScore: 90, codeHit: true }]);

  render(<PairingReviewCard item={DECIDED_GOOD_ITEM} role="manazer" onDecided={() => {}} onSessionExpired={() => {}} />);
  fireEvent.click(screen.getByTestId("pairing-review-change-PR-4"));

  await screen.findByTestId("pairing-review-panel-PR-4");
  expect(fetchPairingCandidates).toHaveBeenCalledWith("PR-4");
});

it("busy guard: kým prvý zápis beží, ✓ Dobré AJ ✗ Zlé sú disabled (jeden zdieľaný guard)", async () => {
  let resolveDecision: (() => void) | undefined;
  sendPairingDecision.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveDecision = resolve;
      }),
  );

  render(<PairingReviewCard item={MATCHED_ITEM} role="manazer" onDecided={() => {}} onSessionExpired={() => {}} />);
  const good = screen.getByTestId<HTMLButtonElement>("pairing-review-good-PR-1");
  const bad = screen.getByTestId<HTMLButtonElement>("pairing-review-open-panel-PR-1");
  expect(good.disabled).toBe(false);
  expect(bad.disabled).toBe(false);

  fireEvent.click(good);
  await waitFor(() => {
    expect(good.disabled).toBe(true);
  });
  expect(bad.disabled).toBe(true);

  resolveDecision?.();
  await waitFor(() => {
    expect(sendPairingDecision).toHaveBeenCalledTimes(1);
  });
});

it("401 pri odoslaní rozhodnutia zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  sendPairingDecision.mockRejectedValue(new PairingReviewUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<PairingReviewCard item={MATCHED_ITEM} role="manazer" onDecided={() => {}} onSessionExpired={onSessionExpired} />);
  fireEvent.click(screen.getByTestId("pairing-review-good-PR-1"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
