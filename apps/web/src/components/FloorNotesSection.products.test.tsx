import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloorNotesSection } from "./FloorNotesSection.js";

const { fetchFloorNotes, attachFloorNoteProduct, detachFloorNoteProduct, updateFloorNoteProductQuantity } = vi.hoisted(() => ({
  fetchFloorNotes: vi.fn(),
  attachFloorNoteProduct: vi.fn(),
  detachFloorNoteProduct: vi.fn(),
  updateFloorNoteProductQuantity: vi.fn(),
}));
vi.mock("../floorNotesApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../floorNotesApi.js")>();
  return { ...actual, fetchFloorNotes, attachFloorNoteProduct, detachFloorNoteProduct, updateFloorNoteProductQuantity };
});

// issue 410: pripínanie produktu ZNOVUPOUŽÍVA `globalSearch` z
// `searchApi.js` (`FloorNoteProductSearch.tsx`) — mockuje sa TU, nie v
// samostatnom module mocku, aby test ostal sebestačný.
const { globalSearch } = vi.hoisted(() => ({ globalSearch: vi.fn() }));
vi.mock("../searchApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../searchApi.js")>();
  return { ...actual, globalSearch };
});

const ROW_BEZ_PRODUKTOV = {
  id: "note-a",
  text: "zákazník chce bundu",
  resolved: false,
  ordered: false,
  called: false,
  createdAt: "2026-08-11T08:00:00.000Z",
  updatedAt: "2026-08-11T08:00:00.000Z",
  products: [],
};

const PRODUKT_S_ODKAZOM = { variantCode: "40237/L", productName: "Bunda Rogaland", sizeLabel: "L", quantity: 2, shopUrl: "https://www.forestshop.sk/bunda/" };
const PRODUKT_BEZ_ODKAZU = { variantCode: "60035/M", productName: "Čiapka Polar", sizeLabel: null, quantity: 1, shopUrl: null };

const SEARCH_HIT = {
  productKey: "P1",
  variantCode: "40237/L",
  productName: "Bunda Rogaland",
  sizeLabel: "L",
  supplier: "VirginiaShop",
  externalCode: null,
  state: "sellable" as const,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("vyhľadá produkt (rovnaká cesta ako Vyhľadať) a pripne ho na zápis", async () => {
  fetchFloorNotes
    .mockResolvedValueOnce([ROW_BEZ_PRODUKTOV])
    .mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_S_ODKAZOM] }]);
  globalSearch.mockResolvedValueOnce({ products: [SEARCH_HIT], orders: [] });
  attachFloorNoteProduct.mockResolvedValueOnce(undefined);

  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");

  fireEvent.click(screen.getByTestId("floor-note-attach-toggle-note-a"));
  const input = screen.getByTestId<HTMLInputElement>("floor-note-product-search-input");
  fireEvent.change(input, { target: { value: "bunda" } });
  fireEvent.click(screen.getByTestId("floor-note-product-search-submit"));

  await screen.findByTestId("floor-note-product-pin-40237/L");
  fireEvent.click(screen.getByTestId("floor-note-product-pin-40237/L"));

  await waitFor(() => {
    expect(attachFloorNoteProduct).toHaveBeenCalledWith("note-a", "40237/L", 1);
  });
  await screen.findByTestId("floor-note-product-link-note-a-40237/L");
});

it("pripnutý produkt S priamou adresou má bežný odkaz (žiadna náhradná trieda/poznámka)", async () => {
  fetchFloorNotes.mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_S_ODKAZOM] }]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);

  const link = await screen.findByTestId<HTMLAnchorElement>("floor-note-product-link-note-a-40237/L");
  expect(link.getAttribute("href")).toBe("https://www.forestshop.sk/bunda/");
  expect(link.className).not.toContain("fallback");
});

// issue 410 (design komentár na ticket-e): nikdy plain-vyzerajúci
// vyhľadávací odkaz, keď priama adresa nie je známa — vizuálne odlíšený
// presne ako `PairingReviewCard.tsx` po issue 402.
it("pripnutý produkt BEZ priamej adresy dostane vizuálne odlíšený náhradný odkaz + poznámku", async () => {
  fetchFloorNotes.mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_BEZ_ODKAZU] }]);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);

  const link = await screen.findByTestId<HTMLAnchorElement>("floor-note-product-link-note-a-60035/M");
  expect(link.className).toContain("floor-note-product-link-fallback");
  expect(link.getAttribute("href")).toContain("vyhladavanie");
  expect(screen.getByTestId("floor-note-row-note-a").textContent).toContain("hľadať na eshope");
});

it("odopne produkt zo zápisu", async () => {
  fetchFloorNotes
    .mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_S_ODKAZOM] }])
    .mockResolvedValueOnce([ROW_BEZ_PRODUKTOV]);
  detachFloorNoteProduct.mockResolvedValueOnce(true);
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-product-link-note-a-40237/L");

  fireEvent.click(screen.getByTestId("floor-note-product-detach-note-a-40237/L"));

  await waitFor(() => {
    expect(detachFloorNoteProduct).toHaveBeenCalledWith("note-a", "40237/L");
  });
  await waitFor(() => {
    expect(screen.queryByTestId("floor-note-product-link-note-a-40237/L")).toBeNull();
  });
});

it("produkt, ktorý je UŽ pripnutý na zápis, má tlačidlo 'Pripnuté' (disabled) vo výsledkoch", async () => {
  fetchFloorNotes.mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_S_ODKAZOM] }]);
  globalSearch.mockResolvedValueOnce({ products: [SEARCH_HIT], orders: [] });
  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-product-link-note-a-40237/L");

  fireEvent.click(screen.getByTestId("floor-note-attach-toggle-note-a"));
  fireEvent.change(screen.getByTestId<HTMLInputElement>("floor-note-product-search-input"), { target: { value: "bunda" } });
  fireEvent.click(screen.getByTestId("floor-note-product-search-submit"));

  const pinButton = await screen.findByTestId<HTMLButtonElement>("floor-note-product-pin-40237/L");
  expect(pinButton.disabled).toBe(true);
  expect(pinButton.textContent).toBe("Pripnuté");
});

it("issue 453: pripne produkt so zadaným počtom kusov 2", async () => {
  fetchFloorNotes
    .mockResolvedValueOnce([ROW_BEZ_PRODUKTOV])
    .mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_S_ODKAZOM] }]);
  globalSearch.mockResolvedValueOnce({ products: [SEARCH_HIT], orders: [] });
  attachFloorNoteProduct.mockResolvedValueOnce(undefined);

  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-note-row-note-a");

  fireEvent.click(screen.getByTestId("floor-note-attach-toggle-note-a"));
  fireEvent.change(screen.getByTestId<HTMLInputElement>("floor-note-product-search-input"), { target: { value: "bunda" } });
  fireEvent.click(screen.getByTestId("floor-note-product-search-submit"));

  await screen.findByTestId("floor-note-product-pin-40237/L");
  fireEvent.change(screen.getByTestId<HTMLInputElement>("floor-note-product-search-qty-40237/L"), { target: { value: "2" } });
  fireEvent.click(screen.getByTestId("floor-note-product-pin-40237/L"));

  await waitFor(() => {
    expect(attachFloorNoteProduct).toHaveBeenCalledWith("note-a", "40237/L", 2);
  });
});

// issue 453: úprava počtu kusov už pripnutého produktu — commit na blur
// (nikdy change+keyDown-Enter, `.claude/rules/frontend-design.md` issue 89).
it("upraví počet kusov pripnutého produktu a zobrazí serverovú hodnotu", async () => {
  fetchFloorNotes
    .mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [PRODUKT_S_ODKAZOM] }])
    .mockResolvedValueOnce([{ ...ROW_BEZ_PRODUKTOV, products: [{ ...PRODUKT_S_ODKAZOM, quantity: 3 }] }]);
  updateFloorNoteProductQuantity.mockResolvedValueOnce(true);

  render(<FloorNotesSection role="manazer" onSessionExpired={vi.fn()} />);
  const input = await screen.findByTestId<HTMLInputElement>("floor-note-product-qty-input-note-a-40237/L");
  expect(input.value).toBe("2");

  fireEvent.change(input, { target: { value: "3" } });
  fireEvent.blur(input);

  await waitFor(() => {
    expect(updateFloorNoteProductQuantity).toHaveBeenCalledWith("note-a", "40237/L", 3);
  });
  // Hodnota po refetch-i musí prísť zo SERVERA (re-query fresh, nikdy starý
  // handle — `.claude/rules/frontend-design.md` issue 151).
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>("floor-note-product-qty-input-note-a-40237/L").value).toBe("3");
  });
});
