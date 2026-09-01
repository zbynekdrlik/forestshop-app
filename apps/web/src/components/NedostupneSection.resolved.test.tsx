import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NedostupneSection } from "./NedostupneSection.js";
import type { NedostupneList } from "../nedostupneApi.js";

// issue 531: testy checkboxu „vyriešené" — vyčlenené z `NedostupneSection.test.tsx`
// (eslint `max-lines: 400`), rovnaký split vzor ako `orders-http*.integration.test.ts`.

const { fetchNedostupneList, setNedostupneResolved, removeReplacementLink, addReplacementLink } = vi.hoisted(() => ({
  fetchNedostupneList: vi.fn(),
  setNedostupneResolved: vi.fn(),
  removeReplacementLink: vi.fn(),
  addReplacementLink: vi.fn(),
}));

// `NedostupneUnauthorizedError` ostáva SKUTOČNÁ trieda (`instanceof` v hooku).
vi.mock("../nedostupneApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nedostupneApi.js")>();
  return { ...actual, fetchNedostupneList, setNedostupneResolved, removeReplacementLink, addReplacementLink };
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

it("akciou-spustený refetch nesmie prepísať optimistické označenie vyriešené (issue 535)", async () => {
  // issue 535 (sesterský race k #536): akcia (tu odstránenie odkazu náhrady)
  // po úspechu volá `load()` (plný GET zoznamu). Kým GET letí, obsluha prepne
  // checkbox „vyriešené" — optimistický `setList`, ŽIADNY `guard.begin()` (nie
  // je to load). GET tak ostáva NAJNOVŠÍ load (prejde `isLatest`) a jeho
  // snímka `resolved` (odfotená PRED tým, ako toggle PUT commitol) by
  // optimistickú zmenu prepísala späť. Guard (load-vs-load) to nechytí — je to
  // load-vs-optimistický-zápis, inú os rieši `reconcileResolved`.
  const LINK = { id: "link-1", url: "https://example.sk/nahrada", createdAt: "2026-08-01T00:00:00.000Z" };
  const WITH_LINK: NedostupneList = { groups: [{ ...GROUP, replacementLinks: [LINK] }], bccMissing: false, mailNotConfigured: false };
  // GET#2 (refetch po odstránení odkazu) je ZASTARANÝ: odkaz už preč, ale
  // `resolved=false` je snímka spred toggle-u.
  const STALE: NedostupneList = { groups: [{ ...GROUP, replacementLinks: [], resolved: false }], bccMissing: false, mailNotConfigured: false };

  let resolveRefetch!: (value: NedostupneList) => void;
  const refetch = new Promise<NedostupneList>((r) => {
    resolveRefetch = r;
  });
  fetchNedostupneList.mockResolvedValueOnce(WITH_LINK).mockReturnValueOnce(refetch);
  removeReplacementLink.mockResolvedValue(undefined);
  setNedostupneResolved.mockResolvedValue(undefined);

  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId(CHECKBOX);

  // Akcia: odstráň odkaz náhrady → jej `.then(load)` spustí GET#2 (zdržaný).
  fireEvent.click(screen.getByTestId(`nedostupne-replacement-link-remove-${LINK.id}`));
  await waitFor(() => {
    expect(fetchNedostupneList).toHaveBeenCalledTimes(2);
  });

  // Počas letu GET#2 obsluha OZNAČÍ „vyriešené" — optimisticky HNEĎ zaškrtnuté.
  fireEvent.click(screen.getByTestId<HTMLInputElement>(CHECKBOX));
  expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(true);
  await waitFor(() => {
    expect(setNedostupneResolved).toHaveBeenCalledWith("40237/L", true);
  });

  // Doruč ZASTARANÝ refetch (resolved=false) a počkaj, kým ho komponent CELÝ
  // spracuje — deterministicky, nie retrying `waitFor(false)` (ten by prešiel
  // na pred-klobber kontrole aj proti rozbitému kódu, `.claude/rules/testing.md`).
  await act(async () => {
    resolveRefetch(STALE);
    await refetch;
    await Promise.resolve();
  });

  // Musí ostať ZAŠKRTNUTÉ — akciou-spustený refetch nesmie prepísať optimistickú zmenu.
  expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(true);
});

it("po commitnutom zápise ochráni JEDEN zastaraný load, potom ustúpi serveru (issue 535 — ohraničená životnosť)", async () => {
  // Code review issue 535: „drž optimistickú hodnotu, kým sa server nezhodne" by
  // po ÚSPEŠNOM PUT maskovalo súbežnú CUDZIU zmenu toho istého variantu
  // donekonečna. Ohraničenie: commitnutý záznam ochráni JEDEN zastaraný in-flight
  // load a zmaže sa → ďalší load už serveru ustúpi (skutočná externá zmena vyhrá).
  const LINK = { id: "link-1", url: "https://example.sk/nahrada", createdAt: "2026-08-01T00:00:00.000Z" };
  const WITH_LINK: NedostupneList = { groups: [{ ...GROUP, replacementLinks: [LINK] }], bccMissing: false, mailNotConfigured: false };
  const SERVER_FALSE: NedostupneList = { groups: [{ ...GROUP, replacementLinks: [], resolved: false }], bccMissing: false, mailNotConfigured: false };

  fetchNedostupneList
    .mockResolvedValueOnce(WITH_LINK) // mount
    .mockResolvedValueOnce(SERVER_FALSE) // GET po removeLink — zastaraný/externý
    .mockResolvedValueOnce(SERVER_FALSE); // GET po addLink — externá zmena teraz vyhrá
  removeReplacementLink.mockResolvedValue(undefined);
  addReplacementLink.mockResolvedValue({ ...LINK, id: "link-2" });
  setNedostupneResolved.mockResolvedValue(undefined);

  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId(CHECKBOX);

  // Označ „vyriešené" a počkaj, kým PUT prejde (commitne záznam).
  fireEvent.click(screen.getByTestId<HTMLInputElement>(CHECKBOX));
  await waitFor(() => {
    expect(setNedostupneResolved).toHaveBeenCalledWith("40237/L", true);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // Akcia 1 (removeLink) → GET vráti resolved=false. Commitnutý záznam ochráni
  // TENTO jeden zastaraný load — checkbox ostáva zaškrtnutý.
  fireEvent.click(screen.getByTestId(`nedostupne-replacement-link-remove-${LINK.id}`));
  await waitFor(() => {
    expect(fetchNedostupneList).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(true);
  });

  // Akcia 2 (addLink) → GET opäť resolved=false. Záznam už zmazaný po akcii 1,
  // takže server (externá zmena) teraz vyhrá — checkbox sa odznačí.
  fireEvent.change(screen.getByTestId(`nedostupne-replacement-link-input-40237/L`), { target: { value: "https://example.sk/dalsia" } });
  fireEvent.click(screen.getByTestId(`nedostupne-replacement-link-add-40237/L`));
  await waitFor(() => {
    expect(fetchNedostupneList).toHaveBeenCalledTimes(3);
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(false);
  });
});

it("rola citanie vidí checkbox, ale nesmie ho prepnúť (disabled)", async () => {
  fetchNedostupneList.mockResolvedValue(LIST);
  render(<NedostupneSection role="citanie" onSessionExpired={vi.fn()} />);
  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.disabled).toBe(true);
});
