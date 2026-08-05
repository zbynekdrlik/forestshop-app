import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NedostupneSection } from "./NedostupneSection.js";

const { fetchNedostupneList, fetchNedostupnePreview, sendNedostupneEmail, addReplacementLink, removeReplacementLink } = vi.hoisted(() => ({
  fetchNedostupneList: vi.fn(),
  fetchNedostupnePreview: vi.fn(),
  sendNedostupneEmail: vi.fn(),
  addReplacementLink: vi.fn(),
  removeReplacementLink: vi.fn(),
}));

// `NedostupneUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `OrderReminderSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../nedostupneApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nedostupneApi.js")>();
  return { ...actual, fetchNedostupneList, fetchNedostupnePreview, sendNedostupneEmail, addReplacementLink, removeReplacementLink };
});

const { NedostupneUnauthorizedError } = await import("../nedostupneApi.js");

// issue 238: automatický "Náhrada:" zoznam (`alternatives`) je preč —
// nahradený majiteľovými RUČNE vloženými odkazmi (`replacementLinks`) +
// preklikom na náš e-shop (`ourProductUrl`) a na dodávateľa (`supplierUrl`).
const GROUP = {
  variantCode: "40237/L",
  itemName: "Nohavice FOREST 1003",
  sizeLabel: "L",
  ourProductUrl: "https://www.forestshop.sk/nohavice-forest-1003/",
  supplierUrl: "https://dodavatel.example/nohavice-1003",
  replacementLinks: [{ id: "link-1", url: "https://www.forestshop.sk/nahradny-produkt/" }],
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

it("zobrazí kartu variantu s ručným odkazom náhrady aj objednávkou zákazníka", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  expect(screen.getByText(/Nohavice FOREST 1003/)).not.toBeNull();
  expect(screen.getByText(/veľkosť L/)).not.toBeNull();
  expect(screen.getByText("https://www.forestshop.sk/nahradny-produkt/")).not.toBeNull();
  expect(screen.getByText("Ján Novák")).not.toBeNull();
});

// issue 238: preklik na náš e-shop (názov produktu) a na dodávateľa (kód) —
// `null` = ostáva NEAKTÍVNY plain text, nikdy vyhľadávací fallback.
it("názov produktu a kód sú preklikateľné, keď appka odkazy pozná", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  const shopLink = screen.getByTestId("nedostupne-shop-link-40237/L");
  expect(shopLink.getAttribute("href")).toBe("https://www.forestshop.sk/nohavice-forest-1003/");
  const supplierLink = screen.getByTestId("nedostupne-supplier-link-40237/L");
  expect(supplierLink.getAttribute("href")).toBe("https://dodavatel.example/nohavice-1003");
});

it("bez odkazu na e-shop/dodávateľa ostáva názov aj kód NEAKTÍVNY plain text", async () => {
  fetchNedostupneList.mockResolvedValue({
    groups: [{ ...GROUP, ourProductUrl: null, supplierUrl: null, replacementLinks: [] }],
    bccMissing: false,
    mailNotConfigured: false,
  });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  expect(screen.queryByTestId("nedostupne-shop-link-40237/L")).toBeNull();
  expect(screen.queryByTestId("nedostupne-supplier-link-40237/L")).toBeNull();
  expect(screen.getByText(/Nohavice FOREST 1003/)).not.toBeNull();
  expect(screen.getByText("40237/L")).not.toBeNull();
});

it("rola citanie VIDÍ ručné odkazy náhrad, ale nesmie ich pridávať/mazať", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  render(<NedostupneSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  expect(screen.getByText("https://www.forestshop.sk/nahradny-produkt/")).not.toBeNull();
  expect(screen.queryByTestId("nedostupne-replacement-link-add-40237/L")).toBeNull();
  expect(screen.queryByTestId("nedostupne-replacement-link-remove-link-1")).toBeNull();
});

it("manazer pridá ručný odkaz náhrady — vstup sa vyprázdni a zoznam sa znova načíta", async () => {
  fetchNedostupneList.mockResolvedValueOnce(LIST_WITH_GROUP).mockResolvedValueOnce({
    groups: [{ ...GROUP, replacementLinks: [...GROUP.replacementLinks, { id: "link-2", url: "https://www.forestshop.sk/druhy/" }] }],
    bccMissing: false,
    mailNotConfigured: false,
  });
  addReplacementLink.mockResolvedValue({ id: "link-2", url: "https://www.forestshop.sk/druhy/" });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  const input = screen.getByTestId("nedostupne-replacement-link-input-40237/L");
  fireEvent.change(input, { target: { value: "https://www.forestshop.sk/druhy/" } });
  fireEvent.click(screen.getByTestId("nedostupne-replacement-link-add-40237/L"));

  await waitFor(() => {
    expect(addReplacementLink).toHaveBeenCalledWith("40237/L", "https://www.forestshop.sk/druhy/");
  });
  await screen.findByText("https://www.forestshop.sk/druhy/");
  expect((input as HTMLInputElement).value).toBe("");
});

it("manazer zmaže ručný odkaz náhrady — zoznam sa znova načíta bez neho", async () => {
  fetchNedostupneList.mockResolvedValueOnce(LIST_WITH_GROUP).mockResolvedValueOnce({
    groups: [{ ...GROUP, replacementLinks: [] }],
    bccMissing: false,
    mailNotConfigured: false,
  });
  removeReplacementLink.mockResolvedValue(undefined);
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-replacement-link-remove-link-1"));

  await waitFor(() => {
    expect(removeReplacementLink).toHaveBeenCalledWith("link-1");
  });
  await waitFor(() => {
    expect(screen.queryByText("https://www.forestshop.sk/nahradny-produkt/")).toBeNull();
  });
});

it("rola citanie NEVIDÍ žiadne akčné tlačidlá (len admin/manazer smie odosielať)", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  render(<NedostupneSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  expect(screen.queryByTestId("nedostupne-send-17600001-40237/L")).toBeNull();
});

it("klik na 'náhľad' otvorí povinný náhľad PRED odoslaním — Odoslať sa ešte nevolá", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Informácia o dostupnosti vašej objednávky — Forestshop.sk", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
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
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
  sendNedostupneEmail.mockResolvedValue({ ok: true });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  fireEvent.click(screen.getByTestId("nedostupne-preview-confirm"));

  await waitFor(() => {
    expect(sendNedostupneEmail).toHaveBeenCalledWith("17600001", "40237/L", "nedostupne", "tok-1", "Ahoj");
  });
  await waitFor(() => {
    expect(screen.queryByTestId("nedostupne-preview")).toBeNull();
  });
});

// issue 277: obsluha vie priamo v okne prepísať text — odošle sa PRESNE to,
// čo je v textovom poli v momente kliknutia na Odoslať, nikdy pôvodný náhľad.
it("obsluha upraví text v náhľade — odošle sa upravený text, nie pôvodný", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
  sendNedostupneEmail.mockResolvedValue({ ok: true });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  const textarea = screen.getByTestId("nedostupne-preview-body");
  fireEvent.change(textarea, { target: { value: "Ešte dopisujem vlastnú vetu." } });
  fireEvent.click(screen.getByTestId("nedostupne-preview-confirm"));

  await waitFor(() => {
    expect(sendNedostupneEmail).toHaveBeenCalledWith("17600001", "40237/L", "nedostupne", "tok-1", "Ešte dopisujem vlastnú vetu.");
  });
});

it("prázdny text v náhľade zablokuje tlačidlo Odoslať", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  fireEvent.change(screen.getByTestId("nedostupne-preview-body"), { target: { value: "   " } });

  expect(screen.getByTestId("nedostupne-preview-confirm").hasAttribute("disabled")).toBe(true);
});

it("zrušenie náhľadu NEPOŠLE nič", async () => {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
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
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
  sendNedostupneEmail.mockResolvedValue({ ok: false, error: "Tento e-mail už bol tejto objednávke odoslaný." });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");

  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
  fireEvent.click(screen.getByTestId("nedostupne-preview-confirm"));

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

// issue 191: náhľad je dialóg cez obrazovku — musí sa dať zavrieť klávesom Esc
// aj klikom mimo neho, a ani jedna z týchto ciest NESMIE nič odoslať.
async function otvorNahlad(): Promise<void> {
  fetchNedostupneList.mockResolvedValue(LIST_WITH_GROUP);
  fetchNedostupnePreview.mockResolvedValue({ ok: true, subject: "Predmet", html: "<p>Ahoj</p>", text: "Ahoj", recipient: "jan@example.sk", customerName: "Ján Novák", previewToken: "tok-1" });
  render(<NedostupneSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("nedostupne-group-40237/L");
  fireEvent.click(screen.getByTestId("nedostupne-send-17600001-40237/L"));
  await screen.findByTestId("nedostupne-preview");
}

it("Esc zavrie náhľad a nič neodošle", async () => {
  await otvorNahlad();

  // Poslucháč klávesu Esc sa registruje v `useEffect` dialógu — ten je PASÍVNY
  // efekt, takže po tom, čo sa dialóg objaví v DOM-e, ešte nemusí byť
  // zaregistrovaný. Jediné stlačenie Esc hneď po zobrazení preto vie prehrať
  // preteky (lokálne prechádzalo, v CI spadlo). Opakované stlačenie vnútri
  // `waitFor` je deterministické: skúša, kým poslucháč nezačne fungovať.
  await waitFor(() => {
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("nedostupne-preview")).toBeNull();
  });
  expect(sendNedostupneEmail).not.toHaveBeenCalled();
});

it("klik mimo dialógu ho zavrie a nič neodošle", async () => {
  await otvorNahlad();

  fireEvent.click(screen.getByTestId("nedostupne-preview-backdrop"));

  await waitFor(() => {
    expect(screen.queryByTestId("nedostupne-preview")).toBeNull();
  });
  expect(sendNedostupneEmail).not.toHaveBeenCalled();
});

// Klik VNÚTRI dialógu vybubláva na ten istý prekryv — bez kontroly cieľa by
// sa náhľad zatváral pri každom kliknutí do jeho vlastného obsahu.
it("klik vnútri dialógu ho nezavrie", async () => {
  await otvorNahlad();

  fireEvent.click(screen.getByTestId("nedostupne-preview"));

  expect(screen.getByTestId("nedostupne-preview")).not.toBeNull();
});

// issue 191, návrat fokusu po zavretí sa overuje LEN e2e testom
// (`tests/e2e/nedostupne.spec.ts`): scenár stojí na tom, že prehliadač zhodí
// fokus zo spúšťacieho tlačidla vo chvíli, keď sa počas načítania náhľadu stane
// `disabled` — jsdom to nerobí (ani `blur()`, ani fokus na iný prvok to tu
// nenapodobní), takže unit test by prešiel aj s pokazeným kódom.

it("dialóg je označený ako modálny a nesie svoj vlastný nadpis", async () => {
  await otvorNahlad();

  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(screen.getByRole("heading", { name: "Náhľad e-mailu — povinné pred odoslaním" })).not.toBeNull();
});
