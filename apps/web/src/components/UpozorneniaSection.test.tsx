import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpozorneniaSection } from "./UpozorneniaSection.js";

const { fetchUpozornenia, markUpozorneniaSeen, createOwnNote, updateOwnNote, deleteOwnNote, resolveUpozornenie, postponeUpozornenie } = vi.hoisted(() => ({
  fetchUpozornenia: vi.fn(),
  markUpozorneniaSeen: vi.fn(),
  createOwnNote: vi.fn(),
  updateOwnNote: vi.fn(),
  deleteOwnNote: vi.fn(),
  resolveUpozornenie: vi.fn(),
  postponeUpozornenie: vi.fn(),
}));

// `UpozorneniaUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `NedostupneSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchUpozornenia, markUpozorneniaSeen, createOwnNote, updateOwnNote, deleteOwnNote, resolveUpozornenie, postponeUpozornenie };
});

const VLASTNA_KARTA = {
  id: "own-1",
  type: "vlastna_poznamka" as const,
  source: "vlastne" as const,
  title: "Schôdzka v stredu",
  details: "o 10:00",
  link: null,
  dueAt: null,
  postponedUntil: null,
  seenAt: null,
  resolvedAt: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "nove" as const,
};

// issue 269 (code review, findings 8/9/10): karta z automatického zdroja s
// odkazom na Shoptet — samostatná fixtúra od `VLASTNA_KARTA` (tá má
// `link: null`, nikdy neponúka odkaz vôbec).
const VRATENIE_KARTA = {
  id: "vratenie-1",
  type: "vratenie" as const,
  source: "appka" as const,
  title: "Objednávka 20600001 — vrátený tovar",
  details: "Zákazník: Ján Novák\nStav objednávky: Vratený tovar",
  link: "https://www.forestshop.sk/admin/vyhladavanie/?string=20600001&src=orders",
  dueAt: null,
  postponedUntil: null,
  seenAt: "2026-08-05T08:00:00.000Z",
  resolvedAt: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "otvorene" as const,
};

// issue 298: karta z automatického zdroja "Nevyzdvihnutá zásielka" — preklik
// vedie PRIAMO na sledovanie na Pošte SK (predtým Shoptet admin objednávka,
// rovnaký odkaz ako `VRATENIE_KARTA` mala). Samostatná fixtúra, aby test
// mohol overiť INÝ štítok (`LINK_LABELS` v `UpozornenieCard.tsx` je teraz
// per-typ rôzny, nie zdieľaný).
const NEVYZDVIHNUTA_KARTA = {
  id: "posta-1",
  type: "nevyzdvihnuta_zasielka" as const,
  source: "appka" as const,
  title: "Zásielka pre objednávku 20500010 sa nevyzdvihla — 5 dní na pošte",
  details: "Zákazník: Ján Novák\nČíslo zásielky: EF123456789SK\nDopravca: Slovenská pošta\nČaká: 5 dní na pošte\nVyzdvihnutie do: 2026-08-15",
  link: "https://www.posta.sk/sledovanie-zasielok#parcel=EF123456789SK",
  dueAt: null,
  postponedUntil: null,
  seenAt: "2026-08-05T08:00:00.000Z",
  resolvedAt: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "otvorene" as const,
};

// issue 299: TRETÍ automatický zdroj — zásielka VRÁTENÁ ODOSIELATEĽOVI,
// nezamieňať s `vratenie` (vrátený TOVAR, stav objednávky). Preklik ide na
// TEN ISTÝ `trackingLink` helper ako `nevyzdvihnuta_zasielka` (obe sú
// Pošta SK zásielkové odkazy) — preto zdieľa jej `LINK_LABELS` štítok.
const VRATENA_ZASIELKA_KARTA = {
  id: "posta-vratena-1",
  type: "vratena_zasielka" as const,
  source: "appka" as const,
  title: "Zásielka pre objednávku 20500018 sa vrátila odosielateľovi",
  details: "Zákazník: Ján Novák\nČíslo zásielky: EF123456789SK\nPošta SK hlási zásielku ako vrátenú odosielateľovi.",
  link: "https://www.posta.sk/sledovanie-zasielok#parcel=EF123456789SK",
  dueAt: null,
  postponedUntil: null,
  seenAt: "2026-08-07T08:00:00.000Z",
  resolvedAt: null,
  createdAt: "2026-08-07T08:00:00.000Z",
  status: "otvorene" as const,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("karta s odkazom (automatický zdroj) zobrazí štítok 'Otvoriť objednávku v Shoptete' a otvára sa v novom okne", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VRATENIE_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-vratenie-1");

  const link = screen.getByTestId<HTMLAnchorElement>("upozornenie-link-vratenie-1");
  expect(link.textContent).toBe("Otvoriť objednávku v Shoptete");
  expect(link.getAttribute("href")).toBe(VRATENIE_KARTA.link);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

it("issue 298: karta 'Nevyzdvihnutá zásielka' zobrazí štítok 'Sledovať zásielku na Pošte' s odkazom na Poštu SK, aj termín vyzdvihnutia v details", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([NEVYZDVIHNUTA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-posta-1");

  const link = screen.getByTestId<HTMLAnchorElement>("upozornenie-link-posta-1");
  expect(link.textContent).toBe("Sledovať zásielku na Pošte");
  expect(link.getAttribute("href")).toBe(NEVYZDVIHNUTA_KARTA.link);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
  expect(screen.getByText(/Vyzdvihnutie do: 2026-08-15/)).toBeTruthy();
});

it("issue 299: karta 'Vrátená zásielka' zobrazí vlastný typový štítok a odkaz na Poštu SK (zdieľaný s nevyzdvihnutou)", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VRATENA_ZASIELKA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-posta-vratena-1");

  expect(screen.getByTestId("upozornenie-type-posta-vratena-1").textContent).toBe("Vrátená zásielka");
  const link = screen.getByTestId<HTMLAnchorElement>("upozornenie-link-posta-vratena-1");
  expect(link.textContent).toBe("Sledovať zásielku na Pošte");
  expect(link.getAttribute("href")).toBe(VRATENA_ZASIELKA_KARTA.link);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

it("prázdny zoznam zobrazí informačnú vetu (po označení videných)", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenia-empty");
  await waitFor(() => {
    expect(markUpozorneniaSeen).toHaveBeenCalledTimes(1);
  });
});

it("zobrazí kartu s 'Nové' štítkom pre nevidenú kartu", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");
  expect(screen.getByTestId("upozornenie-nove-own-1").textContent).toBe("Nové");
  expect(screen.getByText("Schôdzka v stredu")).toBeTruthy();
  expect(screen.getByText("o 10:00")).toBeTruthy();
});

it("rola 'citanie' vidí zoznam, ale NEVIDÍ žiadne akčné tlačidlá ani formulár", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");
  expect(screen.queryByTestId("upozornenie-new")).toBeNull();
  expect(screen.queryByTestId("upozornenie-resolve-own-1")).toBeNull();
  expect(screen.queryByTestId("upozornenie-edit-own-1")).toBeNull();
});

it("karta zo zdroja 'appka' nemá Upraviť/Zmazať, len Vybavené/Odložiť", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([{ ...VLASTNA_KARTA, id: "appka-1", source: "appka" as const }]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-appka-1");
  expect(screen.getByTestId("upozornenie-resolve-appka-1")).toBeTruthy();
  expect(screen.queryByTestId("upozornenie-edit-appka-1")).toBeNull();
  expect(screen.queryByTestId("upozornenie-delete-appka-1")).toBeNull();
});

it("'+ Nové upozornenie' otvorí formulár, uloženie zavolá createOwnNote a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  // Tretie `[]` je issue 267 follow-up gap 3's doplnkový najširší dopyt,
  // ktorý `load()` spraví, keď je zoznam prázdny (tu: hneď po mounte).
  fetchUpozornenia.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([VLASTNA_KARTA]);
  createOwnNote.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenia-empty");

  fireEvent.click(screen.getByTestId("upozornenie-new"));
  fireEvent.change(screen.getByTestId("upozornenie-form-title"), { target: { value: "Schôdzka v stredu" } });
  fireEvent.change(screen.getByTestId("upozornenie-form-details"), { target: { value: "o 10:00" } });
  fireEvent.click(screen.getByTestId("upozornenie-form-save"));

  await waitFor(() => {
    expect(createOwnNote).toHaveBeenCalledWith({ title: "Schôdzka v stredu", details: "o 10:00", dueAt: null });
  });
  await screen.findByTestId("upozornenie-own-1");
});

it("klik na 'Vybavené' zavolá resolveUpozornenie a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValueOnce([VLASTNA_KARTA]).mockResolvedValueOnce([{ ...VLASTNA_KARTA, status: "vybavene" as const }]);
  resolveUpozornenie.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenie-resolve-own-1"));
  await waitFor(() => {
    expect(resolveUpozornenie).toHaveBeenCalledWith("own-1");
  });
});

it("Upraviť predvyplní formulár existujúcimi hodnotami vlastnej poznámky", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenie-edit-own-1"));
  expect(screen.getByTestId<HTMLInputElement>("upozornenie-form-title").value).toBe("Schôdzka v stredu");
  expect(screen.getByTestId<HTMLTextAreaElement>("upozornenie-form-details").value).toBe("o 10:00");
});

it("Zmazať zavolá deleteOwnNote a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  // Tretie `[]` je issue 267 follow-up gap 3's doplnkový najširší dopyt,
  // ktorý `load()` spraví, keď je zoznam prázdny (tu: po zmazaní).
  fetchUpozornenia.mockResolvedValueOnce([VLASTNA_KARTA]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  deleteOwnNote.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenie-delete-own-1"));
  await waitFor(() => {
    expect(deleteOwnNote).toHaveBeenCalledWith("own-1");
  });
  await screen.findByTestId("upozornenia-empty");
});
