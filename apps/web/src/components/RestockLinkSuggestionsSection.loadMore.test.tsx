import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RestockLinkSuggestionsSection } from "./RestockLinkSuggestionsSection.js";

const { searchRestockLinkSuggestions } = vi.hoisted(() => ({ searchRestockLinkSuggestions: vi.fn() }));
vi.mock("../restockLinksApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restockLinksApi.js")>();
  return { ...actual, searchRestockLinkSuggestions };
});

function item(key: string): {
  productKey: string;
  productName: string;
  supplier: string | null;
  candidates: never[];
} {
  return { productKey: key, productName: `Test bunda ${key}`, supplier: "Test dodávateľ", candidates: [] };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// issue 337: tlačidlo "Načítať ďalšie" je JEDINÝ spôsob, ako sa dostať k
// položkám nad prvú stranu (`PAGE_SIZE = 50`) — bez neho by boli natrvalo
// nedosiahnuteľné, hoci server ich vie vrátiť.
it("keď je total väčší než počet zobrazených položiek, ukáže tlačidlo 'Načítať ďalšie' s počtom zvyšných", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 55, items: [item("RL-1")] });

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  const button = await screen.findByTestId("load-more");
  expect(button.textContent).toBe("Načítať ďalšie (50)"); // min(PAGE_SIZE, 55 - 1)
});

it("klik na 'Načítať ďalšie' zavolá search s DRUHOU stranou a pripojí výsledok k existujúcim položkám", async () => {
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 2, items: [item("RL-1")] });
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 2, items: [item("RL-2")] });

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("load-more"));

  await screen.findByTestId("restock-link-row-RL-2");
  // Pôvodná položka ostáva viditeľná — DRUHÁ strana sa PRIPOJILA, nenahradila.
  expect(screen.getByTestId("restock-link-row-RL-1")).toBeTruthy();
  expect(searchRestockLinkSuggestions).toHaveBeenLastCalledWith({ q: "", page: 2 });
  await waitFor(() => {
    expect(screen.queryByTestId("load-more")).toBeNull(); // 2/2 zobrazených — tlačidlo zmizne
  });
});

it("keď sú zobrazené všetky položky, tlačidlo 'Načítať ďalšie' sa vôbec nevykreslí", async () => {
  searchRestockLinkSuggestions.mockResolvedValue({ total: 1, items: [item("RL-1")] });

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("restock-link-row-RL-1");
  expect(screen.queryByTestId("load-more")).toBeNull();
});

it("nové vyhľadávanie (zmena dopytu) resetuje stranu späť na 1 — ďalší klik na 'Načítať ďalšie' žiada znova stranu 2", async () => {
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 2, items: [item("RL-1")] });
  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 2, items: [item("RL-2")] });

  render(<RestockLinkSuggestionsSection role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByTestId("load-more"));
  await screen.findByTestId("restock-link-row-RL-2");

  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 3, items: [item("RL-3")] });
  fireEvent.change(screen.getByLabelText("Hľadať produkt (kód alebo názov)"), { target: { value: "iny" } });
  fireEvent.click(screen.getByRole("button", { name: "Zobraziť" }));
  await screen.findByTestId("restock-link-row-RL-3");

  searchRestockLinkSuggestions.mockResolvedValueOnce({ total: 3, items: [item("RL-4")] });
  fireEvent.click(await screen.findByTestId("load-more"));

  await waitFor(() => {
    expect(searchRestockLinkSuggestions).toHaveBeenLastCalledWith({ q: "iny", page: 2 });
  });
});
