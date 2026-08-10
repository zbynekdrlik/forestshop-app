import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RestockLinkSuggestionsSection } from "./RestockLinkSuggestionsSection.js";

const { searchRestockLinkSuggestions } = vi.hoisted(() => ({ searchRestockLinkSuggestions: vi.fn() }));
const { saveProductLink } = vi.hoisted(() => ({ saveProductLink: vi.fn() }));

// `*UnauthorizedError` ostávajú SKUTOČNÉ triedy z reálnych modulov — rovnaký
// dôvod ako `SupplierLinksSection.test.tsx`: `instanceof` v komponente musí
// fungovať aj v teste.
vi.mock("../restockLinksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restockLinksApi.js")>();
  return { ...actual, searchRestockLinkSuggestions };
});
vi.mock("../supplierLinksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../supplierLinksApi.js")>();
  return { ...actual, saveProductLink };
});

const { RestockLinksUnauthorizedError } = await import("../restockLinksApi.js");

const BEZ_NAVRHU = { productKey: "RL-1", productName: "Test bunda RL-1", supplier: "Test dodávateľ", candidates: [] };
const S_NAVRHOM = {
  productKey: "RL-2",
  productName: "Test bunda RL-2",
  supplier: "Test dodávateľ",
  candidates: [
    { productKey: "RL-CAND", productName: "Test bunda RL-CAND", supplier: "Test dodávateľ", url: "https://dodavatel.example.com/rl-cand" },
  ],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď zoznam nezodpovedá žiadnemu produktu, zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 0, items: [] });

  render(<RestockLinkSuggestionsSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("restock-links-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("zobrazí produkt bez návrhu ako pomlčku a produkt s návrhom s jeho odkazom", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 2, items: [BEZ_NAVRHU, S_NAVRHOM] });

  render(<RestockLinkSuggestionsSection role="citanie" onSessionExpired={() => {}} />);

  const bezNavrhuRiadok = await screen.findByTestId("restock-link-row-RL-1");
  expect(bezNavrhuRiadok.textContent).toContain("Test bunda RL-1");
  expect(screen.getByTestId("restock-link-candidates-RL-1").textContent).toBe("—");

  const sNavrhomBunka = screen.getByTestId("restock-link-candidates-RL-2");
  expect(sNavrhomBunka.textContent).toContain("https://dodavatel.example.com/rl-cand");
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  searchRestockLinkSuggestions.mockRejectedValue(new RestockLinksUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<RestockLinkSuggestionsSection role="citanie" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("rola citanie nevidí stĺpec Akcie ani tlačidlo 'Potvrdiť'", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 1, items: [S_NAVRHOM] });

  render(<RestockLinkSuggestionsSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("restock-link-row-RL-2");
  expect(screen.queryByTestId("restock-link-edit-toggle-RL-2")).toBeNull();
  expect(screen.queryByTestId("restock-link-confirm-RL-2-RL-CAND")).toBeNull();
});

// issue 331: samotné NAČÍTANIE zoznamu nikdy nič neuloží — `saveProductLink`
// sa smie zavolať LEN po výslovnom ľudskom klik na konkrétny návrh.
it("samotné zobrazenie zoznamu s návrhom NEULOŽÍ nič automaticky", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 1, items: [S_NAVRHOM] });

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("restock-link-confirm-RL-2-RL-CAND");
  expect(saveProductLink).not.toHaveBeenCalled();
});

it("rola manazer klikne na 'Potvrdiť' pri návrhu — jeden klik rovno uloží presne tento kandidát", async () => {
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 1, items: [S_NAVRHOM] });
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 0, items: [] });
  saveProductLink.mockResolvedValue(undefined);

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("restock-link-confirm-RL-2-RL-CAND"));

  await waitFor(() => {
    expect(saveProductLink).toHaveBeenCalledWith("RL-2", "https://dodavatel.example.com/rl-cand");
  });
  expect(saveProductLink).toHaveBeenCalledTimes(1);
  expect(searchRestockLinkSuggestions).toHaveBeenCalledTimes(2);
  // Produkt teraz MÁ linku — zmizne zo zoznamu (skutočný, nie optimistický
  // dôkaz, refetch po uložení).
  await screen.findByTestId("restock-links-empty");
});

it("rola manazer doplní VLASTNÝ odkaz (bez návrhu) cez tlačidlo Doplniť", async () => {
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 1, items: [BEZ_NAVRHU] });
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 0, items: [] });
  saveProductLink.mockResolvedValue(undefined);

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("restock-link-edit-toggle-RL-1"));
  const vstup = screen.getByTestId<HTMLInputElement>("restock-link-edit-input-RL-1");
  expect(vstup.value).toBe(""); // žiadny návrh na predvyplnenie
  fireEvent.change(vstup, { target: { value: "https://dodavatel.example.com/rl-1" } });
  fireEvent.click(screen.getByTestId("restock-link-save-RL-1"));

  await waitFor(() => {
    expect(saveProductLink).toHaveBeenCalledWith("RL-1", "https://dodavatel.example.com/rl-1");
  });
});

it("neplatná URL sa odmietne OKAMŽITE v prehliadači, bez volania saveProductLink", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 1, items: [BEZ_NAVRHU] });

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("restock-link-edit-toggle-RL-1"));
  const vstup = screen.getByTestId("restock-link-edit-input-RL-1");
  fireEvent.change(vstup, { target: { value: "nieje-url" } });
  fireEvent.click(screen.getByTestId("restock-link-save-RL-1"));

  await screen.findByText("Odkaz musí byť platná adresa začínajúca http:// alebo https://.");
  expect(saveProductLink).not.toHaveBeenCalled();
});
