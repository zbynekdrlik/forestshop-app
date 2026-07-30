import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingSection } from "./PairingSection.js";

const { searchPairings, confirmPairing } = vi.hoisted(() => ({
  searchPairings: vi.fn(),
  confirmPairing: vi.fn(),
}));

// `PairingUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu — rovnaký
// dôvod ako `OrdersSection.test.tsx`'s `OrdersUnauthorizedError`: `instanceof`
// v komponente musí fungovať aj v teste.
vi.mock("../pairingApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pairingApi.js")>();
  return { ...actual, searchPairings, confirmPairing };
});

const { PairingUnauthorizedError } = await import("../pairingApi.js");

const NAVRHNUTY = {
  variantCode: "40237/3XL",
  variantName: "Nohavice FOREST 1003",
  sizeLabel: "3XL",
  productSupplier: "GRUBE",
  supplierUrl: "https://www.grube.sk/p/1",
  state: "navrhnute" as const,
  confirmedByName: null,
  confirmedAt: null,
};

const POTVRDENY = {
  variantCode: "40238/M",
  variantName: "Nohavice FOREST 1003",
  sizeLabel: "M",
  productSupplier: "GRUBE",
  supplierUrl: "https://www.grube.sk/p/2",
  state: "potvrdene" as const,
  confirmedByName: "Manažér",
  confirmedAt: "2026-07-30T11:00:00.000Z",
};

const BEZ_ADRESY = {
  variantCode: "40239/S",
  variantName: "Čiapka Polar FOREST",
  sizeLabel: null,
  productSupplier: null,
  supplierUrl: null,
  state: "navrhnute" as const,
  confirmedByName: null,
  confirmedAt: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď zoznam nezodpovedá žiadnemu variantu, zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  searchPairings.mockResolvedValue({ total: 0, items: [] });

  render(<PairingSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("pairing-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("zobrazí kód, produkt, veľkosť, dodávateľa, adresu a stav", async () => {
  searchPairings.mockResolvedValue({ total: 2, items: [NAVRHNUTY, POTVRDENY] });

  render(<PairingSection role="citanie" onSessionExpired={() => {}} />);

  const navrhnuty = await screen.findByTestId("pairing-40237/3XL");
  expect(navrhnuty.textContent).toContain("Nohavice FOREST 1003");
  expect(navrhnuty.textContent).toContain("3XL");
  expect(navrhnuty.textContent).toContain("GRUBE");
  expect(navrhnuty.textContent).toContain("Navrhnuté");

  const potvrdeny = screen.getByTestId("pairing-40238/M");
  expect(potvrdeny.textContent).toContain("Potvrdené");
  expect(potvrdeny.textContent).toContain("Manažér");
});

it("chýbajúcu veľkosť a dodávateľa zobrazí ako pomlčku, chýbajúcu adresu tiež", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [BEZ_ADRESY] });

  render(<PairingSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId("pairing-40239/S");
  const bunky = riadok.querySelectorAll("td");
  expect(bunky[2]?.textContent).toContain("—"); // veľkosť
  expect(bunky[3]?.textContent).toContain("—"); // dodávateľ
  expect(bunky[4]?.textContent).toContain("—"); // adresa
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  searchPairings.mockRejectedValue(new PairingUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<PairingSection role="citanie" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("rola citanie nevidí stĺpec Akcie", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [NAVRHNUTY] });

  render(<PairingSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("pairing-40237/3XL");
  expect(screen.queryByTestId("confirm-40237/3XL")).toBeNull();
  expect(screen.queryByTestId("reject-40237/3XL")).toBeNull();
});

it("rola manazer potvrdí navrhnutú adresu jedným klikom, obrazovka sa po potvrdení znova načíta (confirmedByName/At sú AUTORITATÍVNE zo servera)", async () => {
  const POTVRDENY_PO_KLIKU = { ...NAVRHNUTY, state: "potvrdene" as const, confirmedByName: "Manažér", confirmedAt: "2026-07-30T12:00:00.000Z" };
  searchPairings.mockResolvedValueOnce({ total: 1, items: [NAVRHNUTY] });
  searchPairings.mockResolvedValueOnce({ total: 1, items: [POTVRDENY_PO_KLIKU] });
  confirmPairing.mockResolvedValue(undefined);

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  const tlacidlo = await screen.findByTestId("confirm-40237/3XL");
  fireEvent.click(tlacidlo);

  await waitFor(() => {
    expect(confirmPairing).toHaveBeenCalledWith("40237/3XL");
  });
  await waitFor(() => {
    expect(screen.getByTestId("pairing-40237/3XL").textContent).toContain("Manažér");
  });
  expect(searchPairings).toHaveBeenCalledTimes(2); // druhé volanie po potvrdení, aby sa zobrazilo AUTORITATÍVNE meno/čas potvrdenia
});

it("tlačidlo ✓ Potvrdiť je disabled, keď variant nemá žiadnu navrhnutú adresu", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [BEZ_ADRESY] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  const tlacidlo = await screen.findByTestId("confirm-40239/S");
  expect((tlacidlo as HTMLButtonElement).disabled).toBe(true);
});

it("✗ Zadať inú adresu otvorí formulár, uloženie pošle novú adresu a potvrdí", async () => {
  const POTVRDENY_S_NOVOU_ADRESOU = {
    ...BEZ_ADRESY,
    supplierUrl: "https://www.grube.sk/p/nova",
    state: "potvrdene" as const,
    confirmedByName: "Manažér",
    confirmedAt: "2026-07-30T12:00:00.000Z",
  };
  searchPairings.mockResolvedValueOnce({ total: 1, items: [BEZ_ADRESY] });
  searchPairings.mockResolvedValueOnce({ total: 1, items: [POTVRDENY_S_NOVOU_ADRESOU] });
  confirmPairing.mockResolvedValue(undefined);

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("reject-40239/S"));
  const vstup = screen.getByLabelText("Adresa u dodávateľa pre 40239/S");
  fireEvent.change(vstup, { target: { value: "https://www.grube.sk/p/nova" } });
  fireEvent.click(screen.getByRole("button", { name: "Potvrdiť" }));

  await waitFor(() => {
    expect(confirmPairing).toHaveBeenCalledWith("40239/S", "https://www.grube.sk/p/nova");
  });
  await waitFor(() => {
    expect(screen.getByTestId("pairing-40239/S").textContent).toContain("Potvrdené");
  });
});

it("zlyhané potvrdenie zobrazí slovenskú hlášku zo servera a stav sa nezmení", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [NAVRHNUTY] });
  confirmPairing.mockRejectedValue(new Error("Chýba adresa produktu u dodávateľa"));

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("confirm-40237/3XL"));

  await screen.findByText("Chýba adresa produktu u dodávateľa");
  expect(screen.getByTestId("pairing-40237/3XL").textContent).toContain("Navrhnuté");
});

it("potvrdenie pri 401 zavolá onSessionExpired namiesto zobrazenia chyby", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [NAVRHNUTY] });
  confirmPairing.mockRejectedValue(new PairingUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<PairingSection role="manazer" onSessionExpired={onSessionExpired} />);

  fireEvent.click(await screen.findByTestId("confirm-40237/3XL"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
