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

// `40238/M`/`40237/3XL` majú ROZDIELNY `productKey` (rôzne produkty, náhoda
// v podobných kódoch) — issue 47's zoskupovacie testy nižšie majú VLASTNÉ
// fixtúry (`VELKOST_M`/`VELKOST_L`) s rovnakým `productKey`, tieto tri
// zostávajú jednovariantné (`productKey` === vlastný `variantCode`), presne
// ako pred touto zmenou (byte-identická renderovacia cesta).
const NAVRHNUTY = {
  variantCode: "40237/3XL",
  variantName: "Nohavice FOREST 1003",
  sizeLabel: "3XL",
  productKey: "40237/3XL",
  productName: "Nohavice FOREST 1003",
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
  productKey: "40238/M",
  productName: "Nohavice FOREST 1003",
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
  productKey: "40239/S",
  productName: "Čiapka Polar FOREST",
  productSupplier: null,
  supplierUrl: null,
  state: "navrhnute" as const,
  confirmedByName: null,
  confirmedAt: null,
};

// Issue 47 (F4 rozdelenie podľa veľkostí) — jeden produkt ("40260"), DVE
// veľkosti, ROVNAKÁ adresa u dodávateľa (homogénne, zbalené zobrazenie).
const VELKOST_M = {
  variantCode: "40260/M",
  variantName: "Bunda FOREST",
  sizeLabel: "M",
  productKey: "40260",
  productName: "Bunda FOREST",
  productSupplier: "GRUBE",
  supplierUrl: "https://www.grube.sk/p/bunda",
  state: "navrhnute" as const,
  confirmedByName: null,
  confirmedAt: null,
};

const VELKOST_L = {
  ...VELKOST_M,
  variantCode: "40260/L",
  sizeLabel: "L",
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

// Review nález na PR 54 (issue 45): opätovné kliknutie na "✓ Potvrdiť" na UŽ
// potvrdenom riadku by (predtým) ticho prepísalo pôvodného potvrdzujúceho —
// oprava adresy patrí výhradne "✗ Zadať inú adresu", ktoré ostáva enabled.
it("tlačidlo ✓ Potvrdiť je disabled na UŽ potvrdenom riadku, ✗ Zadať inú adresu ostáva enabled", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [POTVRDENY] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  const potvrdit = await screen.findByTestId("confirm-40238/M");
  const zadatInu = await screen.findByTestId("reject-40238/M");
  expect((potvrdit as HTMLButtonElement).disabled).toBe(true);
  expect((zadatInu as HTMLButtonElement).disabled).toBe(false);
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

// Issue 47 — F4 rozdelenie podľa veľkostí. Skupinové (zbalené) zobrazenie sa
// aktivuje LEN pre produkt s viac ako 1 variantom; zoskupenie je odvodené
// (`pairingGroups.ts`), nikdy sa nepersistuje.
it("viacvariantný produkt s ROVNAKOU adresou na oboch veľkostiach sa zobrazí ako JEDEN zbalený riadok", async () => {
  searchPairings.mockResolvedValue({ total: 2, items: [VELKOST_M, VELKOST_L] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  const skupina = await screen.findByTestId("pairing-group-40260");
  expect(skupina.textContent).toContain("Bunda FOREST");
  expect(skupina.textContent).toContain("M, L");
  expect(screen.queryByTestId("pairing-40260/M")).toBeNull();
  expect(screen.queryByTestId("pairing-40260/L")).toBeNull();
});

it("viacvariantný produkt s ROZDIELNOU adresou na veľkostiach sa zobrazí AUTOMATICKY rozdelený (bez klikania)", async () => {
  const inaAdresa = { ...VELKOST_L, supplierUrl: "https://www.grube.sk/p/bunda-inak" };
  searchPairings.mockResolvedValue({ total: 2, items: [VELKOST_M, inaAdresa] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("pairing-40260/M");
  expect(screen.getByTestId("pairing-40260/L")).toBeTruthy();
  expect(screen.queryByTestId("pairing-group-40260")).toBeNull();
});

it("✂ Rozdeliť na veľkosti rozbalí homogénnu skupinu na jednotlivé veľkosti; ↩ Zlúčiť veľkosti ju zabalí späť", async () => {
  searchPairings.mockResolvedValue({ total: 2, items: [VELKOST_M, VELKOST_L] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("split-40260"));

  await screen.findByTestId("pairing-40260/M");
  expect(screen.getByTestId("pairing-40260/L")).toBeTruthy();
  expect(screen.queryByTestId("pairing-group-40260")).toBeNull();

  fireEvent.click(screen.getByTestId("merge-40260"));

  await screen.findByTestId("pairing-group-40260");
  expect(screen.queryByTestId("pairing-40260/M")).toBeNull();
});

it("✓ Potvrdiť na zbalenej skupine potvrdí VŠETKY jej veľkosti (bulk, jeden POST na variant)", async () => {
  searchPairings.mockResolvedValueOnce({ total: 2, items: [VELKOST_M, VELKOST_L] });
  searchPairings.mockResolvedValueOnce({
    total: 2,
    items: [
      { ...VELKOST_M, state: "potvrdene", confirmedByName: "Manažér", confirmedAt: "2026-07-30T12:00:00.000Z" },
      { ...VELKOST_L, state: "potvrdene", confirmedByName: "Manažér", confirmedAt: "2026-07-30T12:00:00.000Z" },
    ],
  });
  confirmPairing.mockResolvedValue(undefined);

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("confirm-group-40260"));

  await waitFor(() => {
    expect(confirmPairing).toHaveBeenCalledWith("40260/M");
    expect(confirmPairing).toHaveBeenCalledWith("40260/L");
  });
  await waitFor(() => {
    expect(screen.getByTestId("pairing-group-40260").textContent).toContain("Potvrdené");
  });
});

it("✗ Zadať inú adresu na zbalenej skupine pošle ROVNAKÚ novú adresu na VŠETKY jej veľkosti", async () => {
  searchPairings.mockResolvedValueOnce({ total: 2, items: [VELKOST_M, VELKOST_L] });
  const novaAdresa = "https://www.grube.sk/p/bunda-nova";
  searchPairings.mockResolvedValueOnce({
    total: 2,
    items: [
      { ...VELKOST_M, supplierUrl: novaAdresa, state: "potvrdene", confirmedByName: "Manažér", confirmedAt: "2026-07-30T12:00:00.000Z" },
      { ...VELKOST_L, supplierUrl: novaAdresa, state: "potvrdene", confirmedByName: "Manažér", confirmedAt: "2026-07-30T12:00:00.000Z" },
    ],
  });
  confirmPairing.mockResolvedValue(undefined);

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("reject-group-40260"));
  fireEvent.change(screen.getByLabelText("Adresa u dodávateľa pre Bunda FOREST (všetky veľkosti)"), {
    target: { value: novaAdresa },
  });
  fireEvent.click(screen.getByRole("button", { name: "Potvrdiť" }));

  await waitFor(() => {
    expect(confirmPairing).toHaveBeenCalledWith("40260/M", novaAdresa);
    expect(confirmPairing).toHaveBeenCalledWith("40260/L", novaAdresa);
  });
  await waitFor(() => {
    expect(screen.getByTestId("pairing-group-40260").textContent).toContain("Potvrdené");
  });
});

it("rola citanie nevidí Akcie ani na zbalenej skupine (žiadne tlačidlo Rozdeliť)", async () => {
  searchPairings.mockResolvedValue({ total: 2, items: [VELKOST_M, VELKOST_L] });

  render(<PairingSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("pairing-group-40260");
  expect(screen.queryByTestId("split-40260")).toBeNull();
  expect(screen.queryByTestId("confirm-group-40260")).toBeNull();
});
