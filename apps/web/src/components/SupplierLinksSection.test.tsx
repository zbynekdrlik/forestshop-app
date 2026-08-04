import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SupplierLinksSection } from "./SupplierLinksSection.js";

const { searchProductLinks, saveProductLink } = vi.hoisted(() => ({
  searchProductLinks: vi.fn(),
  saveProductLink: vi.fn(),
}));

// `SupplierLinksUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu —
// rovnaký dôvod ako `PairingSection.test.tsx`'s `PairingUnauthorizedError`:
// `instanceof` v komponente musí fungovať aj v teste.
vi.mock("../supplierLinksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../supplierLinksApi.js")>();
  return { ...actual, searchProductLinks, saveProductLink };
});

const { SupplierLinksUnauthorizedError } = await import("../supplierLinksApi.js");

const CHYBA = {
  productKey: "PL-1",
  productName: "Test produkt PL-1",
  supplier: "Test dodávateľ",
  variantCount: 2,
  url: null,
  updatedAt: null,
  syncedAt: null,
};

const ULOZENY_NEODOSLANY = {
  productKey: "PL-2",
  productName: "Test produkt PL-2",
  supplier: "Test dodávateľ",
  variantCount: 1,
  url: "https://dodavatel.example.com/pl-2",
  updatedAt: "2026-08-01T09:00:00.000Z",
  syncedAt: null,
};

const ODOSLANY = {
  productKey: "PL-3",
  productName: "Test produkt PL-3",
  supplier: null,
  variantCount: 1,
  url: "https://dodavatel.example.com/pl-3",
  updatedAt: "2026-08-01T09:00:00.000Z",
  syncedAt: "2026-08-02T09:00:00.000Z",
};

const ZO_SHOPTETU = {
  productKey: "PL-4",
  productName: "Test produkt PL-4",
  supplier: "Test dodávateľ",
  variantCount: 1,
  url: "https://shoptet-poznamka.example.com/pl-4",
  updatedAt: null,
  syncedAt: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď zoznam nezodpovedá žiadnemu produktu, zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  searchProductLinks.mockResolvedValue({ total: 0, missingTotal: 0, items: [] });

  render(<SupplierLinksSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("product-links-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("zobrazí kód, názov, dodávateľa, počet variantov a stav pre všetky štyri kombinácie", async () => {
  searchProductLinks.mockResolvedValue({
    total: 4,
    missingTotal: 1,
    items: [CHYBA, ULOZENY_NEODOSLANY, ODOSLANY, ZO_SHOPTETU],
  });

  render(<SupplierLinksSection role="citanie" onSessionExpired={() => {}} />);

  const chybaRiadok = await screen.findByTestId("product-link-row-PL-1");
  expect(chybaRiadok.textContent).toContain("Test produkt PL-1");
  expect(chybaRiadok.textContent).toContain("Test dodávateľ");
  expect(chybaRiadok.textContent).toContain("2");
  expect(screen.getByTestId("product-link-status-PL-1").textContent).toBe("—");

  expect(screen.getByTestId("product-link-status-PL-2").textContent).toContain("čaká na odoslanie");
  expect(screen.getByTestId("product-link-status-PL-3").textContent).toContain("Odoslané do Shoptetu");
  expect(screen.getByTestId("product-link-status-PL-4").textContent).toBe("zo Shoptetu");

  expect(screen.getByTestId("product-links-missing-total").textContent).toContain("1");

  const bezDodavatela = screen.getByTestId("product-link-row-PL-3");
  expect(bezDodavatela.textContent).toContain("(bez dodávateľa)");
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  searchProductLinks.mockRejectedValue(new SupplierLinksUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<SupplierLinksSection role="citanie" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("rola citanie nevidí stĺpec Akcie", async () => {
  searchProductLinks.mockResolvedValue({ total: 1, missingTotal: 1, items: [CHYBA] });

  render(<SupplierLinksSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("product-link-row-PL-1");
  expect(screen.queryByTestId("product-link-edit-toggle-PL-1")).toBeNull();
});

it("rola manazer doplní chýbajúcu linku, uloženie ju pošle na server a obrazovka sa znova načíta", async () => {
  const CHYBA_PO_ULOZENI = { ...CHYBA, url: "https://novy-dodavatel.example.com/pl-1", updatedAt: "2026-08-04T09:00:00.000Z", syncedAt: null };
  searchProductLinks.mockResolvedValueOnce({ total: 1, missingTotal: 1, items: [CHYBA] });
  searchProductLinks.mockResolvedValueOnce({ total: 1, missingTotal: 0, items: [CHYBA_PO_ULOZENI] });
  saveProductLink.mockResolvedValue(undefined);

  render(<SupplierLinksSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("product-link-edit-toggle-PL-1"));
  const vstup = screen.getByTestId("product-link-edit-input-PL-1");
  fireEvent.change(vstup, { target: { value: "https://novy-dodavatel.example.com/pl-1" } });
  fireEvent.click(screen.getByTestId("product-link-save-PL-1"));

  await waitFor(() => {
    expect(saveProductLink).toHaveBeenCalledWith("PL-1", "https://novy-dodavatel.example.com/pl-1");
  });
  await waitFor(() => {
    expect(screen.getByTestId("product-link-url-PL-1").textContent).toBe("https://novy-dodavatel.example.com/pl-1");
  });
  expect(searchProductLinks).toHaveBeenCalledTimes(2); // druhé volanie po uložení
});

it("rola manazer opraví UŽ existujúcu linku (prefill draftu aktuálnou hodnotou)", async () => {
  searchProductLinks.mockResolvedValue({ total: 1, missingTotal: 0, items: [ULOZENY_NEODOSLANY] });

  render(<SupplierLinksSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("product-link-edit-toggle-PL-2"));
  const vstup = screen.getByTestId<HTMLInputElement>("product-link-edit-input-PL-2");
  expect(vstup.value).toBe("https://dodavatel.example.com/pl-2");
});

it("neplatná URL sa odmietne OKAMŽITE v prehliadači, bez volania saveProductLink", async () => {
  searchProductLinks.mockResolvedValue({ total: 1, missingTotal: 1, items: [CHYBA] });

  render(<SupplierLinksSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("product-link-edit-toggle-PL-1"));
  const vstup = screen.getByTestId("product-link-edit-input-PL-1");
  fireEvent.change(vstup, { target: { value: "nieje-url" } });
  fireEvent.click(screen.getByTestId("product-link-save-PL-1"));

  await screen.findByText("Odkaz musí byť platná adresa začínajúca http:// alebo https://.");
  expect(saveProductLink).not.toHaveBeenCalled();
});
