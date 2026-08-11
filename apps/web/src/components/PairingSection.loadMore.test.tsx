import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingSection } from "./PairingSection.js";

const { searchPairings } = vi.hoisted(() => ({ searchPairings: vi.fn() }));
vi.mock("../pairingApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pairingApi.js")>();
  return { ...actual, searchPairings };
});

// Jednovariantné produkty (`productKey === variantCode`) — rovnaký vzor ako
// `PairingSection.test.tsx`'s `NAVRHNUTY`/`POTVRDENY`, aby `renderGroup`
// zobral jednoduchú (nezoskupenú) vetvu.
function item(code: string): {
  variantCode: string;
  variantName: string;
  sizeLabel: string | null;
  productKey: string;
  productName: string;
  productSupplier: string | null;
  supplierUrl: string | null;
  state: "navrhnute";
  confirmedByName: string | null;
  confirmedAt: string | null;
} {
  return {
    variantCode: code,
    variantName: `Test variant ${code}`,
    sizeLabel: null,
    productKey: code,
    productName: `Test variant ${code}`,
    productSupplier: "Test dodávateľ",
    supplierUrl: "https://dodavatel.example.com/x",
    state: "navrhnute",
    confirmedByName: null,
    confirmedAt: null,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// issue 337: bez tlačidla "Načítať ďalšie" boli varianty nad `PAGE_SIZE = 50`
// natrvalo nedosiahnuteľné, hoci server ich vie vrátiť.
it("keď je total väčší než počet zobrazených variantov, ukáže tlačidlo 'Načítať ďalšie' s počtom zvyšných", async () => {
  searchPairings.mockResolvedValue({ total: 51, items: [item("A")] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  const button = await screen.findByTestId("load-more");
  expect(button.textContent).toBe("Načítať ďalšie (50)"); // min(PAGE_SIZE, 51 - 1)
});

it("klik na 'Načítať ďalšie' zavolá search s DRUHOU stranou a pripojí výsledok k existujúcim variantom", async () => {
  searchPairings.mockResolvedValueOnce({ total: 2, items: [item("A")] });
  searchPairings.mockResolvedValueOnce({ total: 2, items: [item("B")] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("load-more"));

  await screen.findByTestId("pairing-B");
  expect(screen.getByTestId("pairing-A")).toBeTruthy();
  expect(searchPairings).toHaveBeenLastCalledWith({ q: "", state: "all", page: 2 });
  await waitFor(() => {
    expect(screen.queryByTestId("load-more")).toBeNull();
  });
});

it("keď sú zobrazené všetky varianty, tlačidlo 'Načítať ďalšie' sa vôbec nevykreslí", async () => {
  searchPairings.mockResolvedValue({ total: 1, items: [item("A")] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("pairing-A");
  expect(screen.queryByTestId("load-more")).toBeNull();
});

// requesting-code-review finding (issue 337, rovnaký nález ako
// `CatalogPage.loadMore.test.tsx`): "Load more" musí žiadať ďalšiu stranu
// naposledy ODOSLANÉHO dopytu, nie práve rozpísaný (neodoslaný) text.
it("po rozpísaní NEODOSLANÉHO nového dopytu žiada 'Načítať ďalšie' ďalej stranu PÔVODNÉHO (naposledy odoslaného) dopytu", async () => {
  searchPairings.mockResolvedValueOnce({ total: 2, items: [item("A")] });
  searchPairings.mockResolvedValueOnce({ total: 2, items: [item("B")] });

  render(<PairingSection role="manazer" onSessionExpired={() => {}} />);
  await screen.findByTestId("pairing-A");

  fireEvent.change(screen.getByLabelText("Kód variantu alebo produktu"), { target: { value: "nieco-ine" } });

  fireEvent.click(await screen.findByTestId("load-more"));
  await screen.findByTestId("pairing-B");

  expect(searchPairings).toHaveBeenLastCalledWith({ q: "", state: "all", page: 2 });
});
