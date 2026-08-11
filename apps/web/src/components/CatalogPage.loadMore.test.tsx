import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogPage } from "./CatalogPage.js";

const { fetchCatalogStats, searchCatalogVariants } = vi.hoisted(() => ({
  fetchCatalogStats: vi.fn(),
  searchCatalogVariants: vi.fn(),
}));
vi.mock("../catalogApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalogApi.js")>();
  return { ...actual, fetchCatalogStats, searchCatalogVariants };
});

function variant(code: string): {
  code: string;
  productKey: string;
  sizeLabel: string | null;
  name: string;
  state: "sellable";
  stock: number;
  price: string | null;
  currency: string | null;
  availabilityText: string;
  missingSince: string | null;
} {
  return {
    code,
    productKey: code,
    sizeLabel: null,
    name: `Test variant ${code}`,
    state: "sellable",
    stock: 1,
    price: null,
    currency: null,
    availabilityText: "Skladom",
    missingSince: null,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// issue 337: bez tlačidla "Načítať ďalšie" boli varianty nad `PAGE_SIZE = 50`
// natrvalo nedosiahnuteľné, hoci server ich vie vrátiť.
it("keď je total väčší než počet zobrazených variantov, ukáže tlačidlo 'Načítať ďalšie' s počtom zvyšných", async () => {
  fetchCatalogStats.mockResolvedValue(null);
  searchCatalogVariants.mockResolvedValue({ total: 60, items: [variant("A")] });

  render(<CatalogPage role="citanie" onSessionExpired={() => {}} />);

  const button = await screen.findByTestId("load-more");
  expect(button.textContent).toBe("Načítať ďalšie (50)"); // min(PAGE_SIZE, 60 - 1)
});

it("klik na 'Načítať ďalšie' zavolá search s DRUHOU stranou a pripojí výsledok k existujúcim variantom", async () => {
  fetchCatalogStats.mockResolvedValue(null);
  searchCatalogVariants.mockResolvedValueOnce({ total: 2, items: [variant("A")] });
  searchCatalogVariants.mockResolvedValueOnce({ total: 2, items: [variant("B")] });

  render(<CatalogPage role="citanie" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("load-more"));

  await screen.findByTestId("variant-B");
  expect(screen.getByTestId("variant-A")).toBeTruthy();
  expect(searchCatalogVariants).toHaveBeenLastCalledWith({ q: "", state: "all", page: 2 });
  await waitFor(() => {
    expect(screen.queryByTestId("load-more")).toBeNull();
  });
});

it("keď sú zobrazené všetky varianty, tlačidlo 'Načítať ďalšie' sa vôbec nevykreslí", async () => {
  fetchCatalogStats.mockResolvedValue(null);
  searchCatalogVariants.mockResolvedValue({ total: 1, items: [variant("A")] });

  render(<CatalogPage role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("variant-A");
  expect(screen.queryByTestId("load-more")).toBeNull();
});
