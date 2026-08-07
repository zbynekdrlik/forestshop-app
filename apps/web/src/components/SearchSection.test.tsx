import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SearchSection } from "./SearchSection.js";

const { globalSearch, fetchProductDetail } = vi.hoisted(() => ({
  globalSearch: vi.fn(),
  fetchProductDetail: vi.fn(),
}));
const { saveProductLink } = vi.hoisted(() => ({ saveProductLink: vi.fn() }));

// `SearchUnauthorizedError`/`SupplierLinksUnauthorizedError` ostávajú SKUTOČNÉ
// triedy z reálnych modulov — rovnaký dôvod ako `SupplierLinksSection.test.tsx`:
// `instanceof` v komponente musí fungovať aj v teste.
vi.mock("../searchApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../searchApi.js")>();
  return { ...actual, globalSearch, fetchProductDetail };
});
vi.mock("../supplierLinksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../supplierLinksApi.js")>();
  return { ...actual, saveProductLink };
});

const { SearchUnauthorizedError } = await import("../searchApi.js");
const { SupplierLinksUnauthorizedError } = await import("../supplierLinksApi.js");

const PRODUKT = {
  productKey: "PD-1",
  variantCode: "PD-1",
  productName: "Test produkt PD-1",
  sizeLabel: null,
  supplier: "Test dodávateľ",
  externalCode: "EXT-1",
  state: "sellable" as const,
};

const OBJEDNAVKA = {
  orderId: "order-1",
  externalOrderId: "9001",
  customerName: "Zákazník Alfa",
  email: "alfa@example.com",
  statusName: "Vybavuje sa",
  placedAt: "2026-07-01T10:00:00.000Z",
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=9001&src=orders",
};

const DETAIL_BEZ_LINKY = {
  productKey: "PD-1",
  productName: "Test produkt PD-1",
  supplier: "Test dodávateľ",
  supplierLinkUrl: null,
  supplierLinkUpdatedAt: null,
  supplierLinkSyncedAt: null,
  variants: [
    {
      code: "PD-1",
      sizeLabel: null,
      name: "Test produkt PD-1",
      state: "sellable" as const,
      stock: 5,
      price: "19.90",
      currency: "EUR",
      availabilityText: "Skladom",
      productVisibility: "visible",
      externalCode: "EXT-1",
      missingSince: null,
      ourShopUrl: "https://www.forestshop.sk/pd-1/",
      supplierAvailability: null,
      supplierAvailabilityText: null,
    },
  ],
};

// issue 289: dve NEZÁVISLÉ polia — "Produkt" (tento súbor) a "Objednávka"
// (`OrderSearchPanel.test.tsx`). Obe volajú tú istú `globalSearch(q)`, každé
// si berie len svoju polovicu odpovede.
function submitProductSearch(query: string): void {
  fireEvent.change(screen.getByLabelText("Produkt"), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "Hľadať produkt" }));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny výsledok produktu zobrazí informačnú vetu namiesto tabuľky", async () => {
  globalSearch.mockResolvedValue({ products: [], orders: [] });

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  submitProductSearch("nieco-co-nikde-nie-je");

  await screen.findByTestId("search-product-empty");
  expect(screen.queryByTestId("search-products")).toBeNull();
});

it("obe polia (Produkt aj Objednávka) sú vždy prítomné a nezávislé — hľadanie produktu nevolá do poľa objednávky", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  expect(screen.getByLabelText("Produkt")).toBeTruthy();
  expect(screen.getByLabelText("Objednávka")).toBeTruthy();

  submitProductSearch("spolocne");

  const produkty = await screen.findByTestId("search-products");
  expect(produkty.textContent).toContain("Test produkt PD-1");
  // Pole "Objednávka" hľadanie produktu vôbec nezasiahlo — žiadny jeho blok.
  expect(screen.queryByTestId("search-orders")).toBeNull();
});

it("pri 401 pri hľadaní produktu zavolá onSessionExpired", async () => {
  globalSearch.mockRejectedValue(new SearchUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<SearchSection role="citanie" onSessionExpired={onSessionExpired} />);
  submitProductSearch("hocico");

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("klik na 'Otvoriť' pri produkte otvorí detail so všetkými variantmi", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValue(DETAIL_BEZ_LINKY);

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  submitProductSearch("PD-1");

  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));

  await screen.findByTestId("search-detail-section");
  expect(fetchProductDetail).toHaveBeenCalledWith("PD-1");
  expect(screen.getByTestId("search-detail-name").textContent).toBe("Test produkt PD-1");
  expect(screen.getByTestId("search-detail-variant-PD-1").textContent).toContain("19.90");
  expect(screen.getByTestId("search-detail-shop-link-PD-1")).toHaveProperty("href", "https://www.forestshop.sk/pd-1/");
});

it("detail produktu neschová pole Objednávka — zostáva namontované vedľa", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValue(DETAIL_BEZ_LINKY);

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));

  await screen.findByTestId("search-detail-section");
  expect(screen.getByLabelText("Objednávka")).toBeTruthy();
});

it("späť z detailu vráti na hľadanie", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValue(DETAIL_BEZ_LINKY);

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));
  await screen.findByTestId("search-detail-section");

  fireEvent.click(screen.getByTestId("search-back"));
  await screen.findByTestId("search-section");
});

it("rola citanie nevidí tlačidlo na úpravu linky", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValue(DETAIL_BEZ_LINKY);

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));

  await screen.findByTestId("search-detail-section");
  expect(screen.queryByTestId("search-detail-link-edit-toggle")).toBeNull();
});

it("rola manazer doplní dodávateľskú linku, uloženie ju pošle na server a detail sa znova načíta so stavom", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValueOnce(DETAIL_BEZ_LINKY).mockResolvedValueOnce({
    ...DETAIL_BEZ_LINKY,
    supplierLinkUrl: "https://novy-dodavatel.example.com/pd-1",
    supplierLinkUpdatedAt: "2026-08-04T09:00:00.000Z",
    supplierLinkSyncedAt: null,
  });
  saveProductLink.mockResolvedValue(undefined);

  render(<SearchSection role="manazer" onSessionExpired={() => {}} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));
  await screen.findByTestId("search-detail-section");

  fireEvent.click(screen.getByTestId("search-detail-link-edit-toggle"));
  const vstup = screen.getByTestId("search-detail-link-edit-input");
  fireEvent.change(vstup, { target: { value: "https://novy-dodavatel.example.com/pd-1" } });
  fireEvent.click(screen.getByTestId("search-detail-link-save"));

  await waitFor(() => {
    expect(saveProductLink).toHaveBeenCalledWith("PD-1", "https://novy-dodavatel.example.com/pd-1");
  });
  await waitFor(() => {
    expect(screen.getByTestId("search-detail-link-value").textContent).toBe("https://novy-dodavatel.example.com/pd-1");
  });
  expect(screen.getByTestId("search-detail-link-status").textContent).toContain("čaká na odoslanie");
  expect(fetchProductDetail).toHaveBeenCalledTimes(2);
});

it("neplatná URL sa odmietne OKAMŽITE, bez volania saveProductLink", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValue(DETAIL_BEZ_LINKY);

  render(<SearchSection role="manazer" onSessionExpired={() => {}} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));
  await screen.findByTestId("search-detail-section");

  fireEvent.click(screen.getByTestId("search-detail-link-edit-toggle"));
  const vstup = screen.getByTestId("search-detail-link-edit-input");
  fireEvent.change(vstup, { target: { value: "nieje-url" } });
  fireEvent.click(screen.getByTestId("search-detail-link-save"));

  await screen.findByText("Odkaz musí byť platná adresa začínajúca http:// alebo https://.");
  expect(saveProductLink).not.toHaveBeenCalled();
});

it("pri 401 pri načítaní detailu zavolá onSessionExpired", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockRejectedValue(new SearchUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<SearchSection role="citanie" onSessionExpired={onSessionExpired} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("pri 401 pri ukladaní linky zavolá onSessionExpired", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [] });
  fetchProductDetail.mockResolvedValue(DETAIL_BEZ_LINKY);
  saveProductLink.mockRejectedValue(new SupplierLinksUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<SearchSection role="manazer" onSessionExpired={onSessionExpired} />);
  submitProductSearch("PD-1");
  fireEvent.click(await screen.findByTestId("search-product-open-PD-1"));
  await screen.findByTestId("search-detail-section");

  fireEvent.click(screen.getByTestId("search-detail-link-edit-toggle"));
  fireEvent.change(screen.getByTestId("search-detail-link-edit-input"), {
    target: { value: "https://novy.example.com/pd-1" },
  });
  fireEvent.click(screen.getByTestId("search-detail-link-save"));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

// Objednávka OBJEDNAVKA je tu len ako potvrdenie, že `globalSearch`'s
// `.orders` polovica pri hľadaní PRODUKTU (Produkt pole) neovplyvní jeho
// vlastný výsledok — plné pokrytie hľadania objednávky je v
// `OrderSearchPanel.test.tsx`.
it("hľadanie produktu ignoruje .orders polovicu odpovede", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [OBJEDNAVKA] });

  render(<SearchSection role="citanie" onSessionExpired={() => {}} />);
  submitProductSearch("spolocne");

  await screen.findByTestId("search-products");
  expect(screen.queryByTestId("search-orders")).toBeNull();
});
