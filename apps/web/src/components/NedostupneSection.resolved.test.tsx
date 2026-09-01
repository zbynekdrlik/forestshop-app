import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NedostupneSection } from "./NedostupneSection.js";
import type { NedostupneList } from "../nedostupneApi.js";

// issue 531: testy checkboxu „vyriešené" — vyčlenené z `NedostupneSection.test.tsx`
// (eslint `max-lines: 400`), rovnaký split vzor ako `orders-http*.integration.test.ts`.

const { fetchNedostupneList, setNedostupneResolved } = vi.hoisted(() => ({
  fetchNedostupneList: vi.fn(),
  setNedostupneResolved: vi.fn(),
}));

// `NedostupneUnauthorizedError` ostáva SKUTOČNÁ trieda (`instanceof` v hooku).
vi.mock("../nedostupneApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nedostupneApi.js")>();
  return { ...actual, fetchNedostupneList, setNedostupneResolved };
});

const GROUP = {
  variantCode: "40237/L",
  itemName: "Nohavice FOREST 1003",
  sizeLabel: "L",
  ourProductUrl: null,
  supplierUrl: null,
  replacementLinks: [],
  resolved: false,
  orders: [
    {
      orderCode: "17600001",
      orderId: "order-1",
      adminLink: "https://x/1",
      customerName: "Ján Novák",
      email: "jan@example.sk",
      quantity: 2,
      placedAt: "2026-07-20T10:00:00.000Z",
      nedostupneSent: false,
      alternativaSent: false,
      comment: null,
    },
  ],
};

const LIST = { groups: [GROUP], bccMissing: false, mailNotConfigured: false };
const CHECKBOX = "nedostupne-resolved-checkbox-40237/L";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("nevyriešený variant má checkbox odznačený", async () => {
  fetchNedostupneList.mockResolvedValue(LIST);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.checked).toBe(false);
});

it("už vyriešený variant má checkbox zaškrtnutý", async () => {
  fetchNedostupneList.mockResolvedValue({ groups: [{ ...GROUP, resolved: true }], bccMissing: false, mailNotConfigured: false });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.checked).toBe(true);
});

it("klik uloží stav na server a optimisticky prekreslí zaškrtnutie bez reloadu zoznamu", async () => {
  fetchNedostupneList.mockResolvedValue(LIST);
  setNedostupneResolved.mockResolvedValue(undefined);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);

  fireEvent.click(checkbox);

  // Optimistická zmena je viditeľná HNEĎ (bez čakania na server).
  expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(true);
  await waitFor(() => {
    expect(setNedostupneResolved).toHaveBeenCalledWith("40237/L", true);
  });
  // Žiadny plný reload zoznamu — `fetchNedostupneList` sa po označení nevolá znova.
  expect(fetchNedostupneList).toHaveBeenCalledTimes(1);
});

it("opätovný klik odznačí (toggle) — pošle resolved=false", async () => {
  fetchNedostupneList.mockResolvedValue({ groups: [{ ...GROUP, resolved: true }], bccMissing: false, mailNotConfigured: false });
  setNedostupneResolved.mockResolvedValue(undefined);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.checked).toBe(true);

  fireEvent.click(checkbox);

  expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(false);
  await waitFor(() => {
    expect(setNedostupneResolved).toHaveBeenCalledWith("40237/L", false);
  });
});

it("zlyhaný zápis vráti checkbox späť a zobrazí hlášku", async () => {
  fetchNedostupneList.mockResolvedValue(LIST);
  setNedostupneResolved.mockRejectedValue(new Error("Označenie sa nepodarilo uložiť."));
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);

  fireEvent.click(checkbox);

  // Po chybe sa optimistická zmena vráti späť na pôvodný (odznačený) stav.
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(false);
  });
  await screen.findByText("Označenie sa nepodarilo uložiť.");
});

it("zastaraná odpoveď zoznamu (StrictMode duplicitný GET) nesmie prepísať optimistické odznačenie", async () => {
  // issue 531 flake (main CI 33557805594, nedostupne.spec.ts checkbox toggle):
  // appka beží pod `<StrictMode>` (main.tsx) a vo vývojovom móde (aj `pnpm
  // e2e` cez vite dev) sa mount efekt `useEffect(load)` spustí DVAKRÁT → dva
  // GET-y zoznamu. `load()` bez stale-response guardu (issue 251/523 trieda)
  // aplikuje KAŽDÚ odpoveď na `setList` — takže pomalší duplicitný GET doletí
  // AŽ PO optimistickom odznačení a prepíše ho späť na zaškrtnuté.
  //
  // Reprodukcia: PRVÝ (skorší) GET je zdržaný a zastaraný, DRUHÝ okamžitý —
  // takže checkbox sa v OBOCH (rozbitej aj opravenej) verzii vykreslí z toho
  // najnovšieho GET-u, a klobber pochádza zo zastaraného skoršieho GET-u
  // (bez guardu ho aplikuje, s guardom ho zahodí).
  const CHECKED: NedostupneList = { groups: [{ ...GROUP, resolved: true }], bccMissing: false, mailNotConfigured: false };
  let resolveStale!: (value: NedostupneList) => void;
  const stale = new Promise<NedostupneList>((r) => {
    resolveStale = r;
  });
  fetchNedostupneList.mockReturnValueOnce(stale).mockResolvedValueOnce(CHECKED);
  setNedostupneResolved.mockResolvedValue(undefined);

  render(
    <StrictMode>
      <NedostupneSection role="manazer" onSessionExpired={vi.fn()} />
    </StrictMode>,
  );

  // Checkbox sa vykreslí z NAJNOVŠIEHO (druhého, okamžitého) GET-u — zaškrtnutý.
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.checked).toBe(true);

  // Odznač (toggle) — optimisticky HNEĎ odznačené, PUT odletí.
  fireEvent.click(checkbox);
  expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(false);
  await waitFor(() => {
    expect(setNedostupneResolved).toHaveBeenCalledWith("40237/L", false);
  });

  // Doruč ZASTARANÚ odpoveď skoršieho GET-u (resolved=true) a POČKAJ, kým ju
  // komponent CELÚ spracuje (`.then` mikrotaska + React re-render pod `act`) —
  // deterministicky, žiadne pevné oneskorenie. Až POTOM plochá asercia: keby
  // sa použil retrying `waitFor(false)`, prešiel by na PRVEJ (pred-klobber)
  // kontrole aj proti rozbitému kódu (`.claude/rules/testing.md` — „čakanie
  // urobí test zeleným zo zlého dôvodu").
  await act(async () => {
    resolveStale(CHECKED);
    await stale;
    await Promise.resolve();
  });

  // Musí ostať ODZNAČENÉ — zastaraná odpoveď nesmie prepísať optimistickú zmenu.
  expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(false);
});

it("rola citanie vidí checkbox, ale nesmie ho prepnúť (disabled)", async () => {
  fetchNedostupneList.mockResolvedValue(LIST);
  render(<NedostupneSection role="citanie" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.disabled).toBe(true);
});
