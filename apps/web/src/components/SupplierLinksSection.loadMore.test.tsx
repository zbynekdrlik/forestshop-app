import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SupplierLinksSection } from "./SupplierLinksSection.js";

const { searchProductLinks } = vi.hoisted(() => ({ searchProductLinks: vi.fn() }));
vi.mock("../supplierLinksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../supplierLinksApi.js")>();
  return { ...actual, searchProductLinks };
});

function item(key: string): {
  productKey: string;
  productName: string;
  supplier: string | null;
  variantCount: number;
  url: string | null;
  updatedAt: string | null;
  syncedAt: string | null;
} {
  return {
    productKey: key,
    productName: `Test produkt ${key}`,
    supplier: "Test dodávateľ",
    variantCount: 1,
    url: null,
    updatedAt: null,
    syncedAt: null,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// issue 337: bez tlačidla "Načítať ďalšie" boli položky nad `PAGE_SIZE = 50`
// natrvalo nedosiahnuteľné (aj keď server má koľko chceš stránok).
it("keď je total väčší než počet zobrazených položiek, ukáže tlačidlo 'Načítať ďalšie' s počtom zvyšných", async () => {
  searchProductLinks.mockResolvedValue({ total: 52, missingTotal: 52, items: [item("PL-1")] });

  render(<SupplierLinksSection role="manazer" onSessionExpired={() => {}} />);

  const button = await screen.findByTestId("load-more");
  expect(button.textContent).toBe("Načítať ďalšie (50)"); // min(PAGE_SIZE, 52 - 1)
});

it("klik na 'Načítať ďalšie' zavolá search s DRUHOU stranou (rovnaký filter/dopyt) a pripojí výsledok", async () => {
  searchProductLinks.mockResolvedValueOnce({ total: 2, missingTotal: 2, items: [item("PL-1")] });
  searchProductLinks.mockResolvedValueOnce({ total: 2, missingTotal: 2, items: [item("PL-2")] });

  render(<SupplierLinksSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("load-more"));

  await screen.findByTestId("product-link-row-PL-2");
  expect(screen.getByTestId("product-link-row-PL-1")).toBeTruthy(); // pripojené, nie nahradené
  expect(searchProductLinks).toHaveBeenLastCalledWith({ q: "", state: "missing", page: 2 });
  await waitFor(() => {
    expect(screen.queryByTestId("load-more")).toBeNull();
  });
});

it("keď sú zobrazené všetky položky, tlačidlo 'Načítať ďalšie' sa vôbec nevykreslí", async () => {
  searchProductLinks.mockResolvedValue({ total: 1, missingTotal: 1, items: [item("PL-1")] });

  render(<SupplierLinksSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("product-link-row-PL-1");
  expect(screen.queryByTestId("load-more")).toBeNull();
});
