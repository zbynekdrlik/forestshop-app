import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NedostupneSection } from "./NedostupneSection.js";

const { fetchNedostupneList, fetchNedostupnePreview, sendNedostupneEmail } = vi.hoisted(() => ({
  fetchNedostupneList: vi.fn(),
  fetchNedostupnePreview: vi.fn(),
  sendNedostupneEmail: vi.fn(),
}));

// `NedostupneUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `OrderReminderSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../nedostupneApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nedostupneApi.js")>();
  return { ...actual, fetchNedostupneList, fetchNedostupnePreview, sendNedostupneEmail };
});

const { NedostupneUnauthorizedError } = await import("../nedostupneApi.js");

const GROUP = {
  variantCode: "40237/L",
  itemName: "Nohavice FOREST 1003",
  sizeLabel: "L",
  alternatives: [{ code: "60116/90", name: "Podkolienky BOBR", url: "https://www.forestshop.sk/vyhladavanie/?string=60116%2F90" }],
  orders: [
    {
      orderCode: "17600001",
      adminLink: "https://www.forestshop.sk/admin/vyhladavanie/?string=17600001&src=orders",
      customerName: "Ján Novák",
      email: "jan@example.sk",
      quantity: 2,
      placedAt: "2026-07-20T10:00:00.000Z",
      nedostupneSent: false,
      alternativaSent: false,
    },
  ],
};

const LIST_WITH_GROUP = { groups: [GROUP], bccMissing: false, mailNotConfigured: false };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchNedostupneList.mockResolvedValue({ groups: [], bccMissing: false, mailNotConfigured: false });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-empty");
});

it("chýbajúca BCC/mail konfigurácia zobrazí obe upozornenia", async () => {
  fetchNedostupneList.mockResolvedValue({ groups: [], bccMissing: true, mailNotConfigured: true });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-bcc-missing");
  await screen.findByTestId("nedostupne-mail-not-configured");
});

it("zobrazí kartu variantu s náhradou aj objednávkou zákazníka", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  expect(screen.getByText(/Nohavice FOREST 1003/)).not.toBeNull();
  expect(screen.getByText(/veľkosť L/)).not.toBeNull();
  expect(screen.getByText("Podkolienky BOBR")).not.toBeNull();
  expect(screen.getByText("Ján Novák")).not.toBeNull();
});

it("rola citanie NEVIDÍ žiadne akčné tlačidlá (len admin/manazer smie odosielať)", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  render(<NedostupneSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  expect(screen.queryByTestId("nedostupne-send-17600001-40237/L")).toBeNull();
});

it("klik na 'náhľad' otvorí povinný náhľad PRED odoslaním — Odoslať sa ešte nevolá", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Informácia o dostupnosti vašej objednávky — Forestshop.sk", html: "<p>Ahoj</p>", recipient: "jan@example.sk", customerName: "Ján Novák" });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  expect(fetchNedostupnePreview).toHaveBeenCalledWith("17600001", "40237/L", "nedostupne");
  expect(sendNedostupneEmail).not.toHaveBeenCalled();
  expect(screen.getAllByText(/jan@example\.sk/).length).toBeGreaterThan(0);
});

it("potvrdenie náhľadu odošle presne s parametrami náhľadu a znovu načíta zoznam", async () => {
  fetchNedostupneList.mockResolvedValueOnce(LIST_WITH_GROUP).mockResolvedValueOnce({
    groups: [{ ...GROUP, orders: [{ ...GROUP.orders[0], nedostupneSent: true }] }],
    bccMissing: false,
    mailNotConfigured: false,
  });
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", recipient: "jan@example.sk", customerName: "Ján Novák" });
  sendNedostupneEmail.mockResolvedValue({ ok: true });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  fireEvent.click(screen.getByTestId("nedostupne-confirm-send"));

  await waitFor(() => {
    expect(sendNedostupneEmail).toHaveBeenCalledWith("17600001", "40237/L", "nedostupne");
  });
  await waitFor(() => {
    expect(screen.queryByTestId("nedostupne-preview")).toBeNull();
  });
});

it("zrušenie náhľadu NEPOŠLE nič", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", recipient: "jan@example.sk", customerName: "Ján Novák" });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  fireEvent.click(screen.getByText("Zrušiť"));
  await waitFor(() => {
    expect(screen.queryByTestId("nedostupne-preview")).toBeNull();
  });
  expect(sendNedostupneEmail).not.toHaveBeenCalled();
});

it("zlyhané odoslanie (ok:false) zobrazí server hlášku a nezavrie náhľad", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", recipient: "jan@example.sk", customerName: "Ján Novák" });
  sendNedostupneEmail.mockResolvedValue({ ok: false, error: "Tento e-mail už bol tejto objednávke odoslaný." });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  fireEvent.click(screen.getByTestId("nedostupne-confirm-send"));

  await screen.findByText("Tento e-mail už bol tejto objednávke odoslaný.");
  expect(screen.getByTestId("nedostupne-preview")).not.toBeNull();
});

it("401 pri načítaní zavolá onSessionExpired", async () => {
  const onSessionExpired = vi.fn();
  fetchNedostupneList.mockRejectedValue(new NedostupneUnauthorizedError());
  render(<NedostupneSection role="manazer" onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
