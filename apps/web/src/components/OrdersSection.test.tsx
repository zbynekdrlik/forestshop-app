import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

const {
  fetchOpenOrders,
  updateOrderLineState,
  updateOrderLineOrdered,
  setSupplierLinesOrdered,
  setSupplierEmail,
  fetchSupplierOrderMailPreview,
  sendSupplierOrderMail,
} = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  updateOrderLineState: vi.fn(),
  updateOrderLineOrdered: vi.fn(),
  setSupplierLinesOrdered: vi.fn(),
  setSupplierEmail: vi.fn(),
  fetchSupplierOrderMailPreview: vi.fn(),
  sendSupplierOrderMail: vi.fn(),
}));

// `OrdersUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu — rovnaký
// dôvod ako `SchedulerSection.test.tsx`'s `SchedulerUnauthorizedError`:
// `instanceof` v komponente musí fungovať aj v teste.
vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    updateOrderLineState,
    updateOrderLineOrdered,
    setSupplierLinesOrdered,
    setSupplierEmail,
    fetchSupplierOrderMailPreview,
    sendSupplierOrderMail,
  };
});

const { OrdersUnauthorizedError } = await import("../ordersApi.js");

const LINE_STARA = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník Starý",
  comment: null,
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Nohavice FOREST 1003",
  sizeLabel: "3XL",
  quantity: 2,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
};

const LINE_NOVA = {
  lineId: "22222222-2222-2222-2222-222222222222",
  orderId: "bbbbbbbb-2222-2222-2222-222222222222",
  externalOrderId: "1002",
  customerName: "Zákazník Nový",
  comment: "Zavolať pred doručením",
  placedAt: "2026-07-15T00:00:00.000Z",
  variantCode: "B-1",
  variantName: "Bunda FOREST 2001",
  sizeLabel: null,
  quantity: 1,
  state: "skladom" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď zatiaľ nie sú žiadne otvorené objednávky, zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  fetchOpenOrders.mockResolvedValue([]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("orders-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("zoskupí riadky podľa dodávateľa a zobrazí produkt, veľkosť, množstvo a stav", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_NOVA, LINE_STARA], email: null },
  ]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const skupina = await screen.findByTestId("supplier-Dodávateľ Alfa");
  expect(skupina.textContent).toContain("Dodávateľ Alfa");

  const novy = screen.getByTestId(`order-line-${LINE_NOVA.lineId}`);
  expect(novy.textContent).toContain("1002");
  expect(novy.textContent).toContain("Zákazník Nový");
  expect(novy.textContent).toContain("B-1");
  expect(novy.textContent).toContain("Bunda FOREST 2001");
  expect(novy.textContent).toContain("Skladom");
  expect(novy.textContent).toContain("Zavolať pred doručením");

  const stary = screen.getByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(stary.textContent).toContain("3XL");
  // issue 60: východiskový stav "objednane" sa teraz volá "Nevybavené" — slovo
  // "Objednané" je odteraz VÝLUČNE nové odškrtávacie políčko, nie tento stav.
  expect(stary.textContent).toContain("Nevybavené");
});

it("chýbajúcu veľkosť a komentár zobrazí ako pomlčku", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_NOVA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE_NOVA.lineId}`);
  // LINE_NOVA má sizeLabel: null — zobrazí sa pomlčka namiesto prázdneho políčka.
  expect(riadok.textContent).toContain("—");
});

// issue 67: odkaz na tovar u dodávateľa a kód dodávateľa — tri tvary, aké
// export skutočne obsahuje.
it("riadok s odkazom na dodávateľa zobrazí klikateľný odkaz aj kód dodávateľa", async () => {
  const riadokSOdkazom = {
    ...LINE_STARA,
    supplierUrl: "https://www.huntingshop.eu/wild-t-green-nohavice",
    supplierNote: "https://www.huntingshop.eu/wild-t-green-nohavice",
    externalCode: "OB832",
  };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [riadokSOdkazom], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const bunka = await screen.findByTestId(`supplier-link-${LINE_STARA.lineId}`);
  // issue 70: aria-label nesie názov produktu, aby riadky nemali rovnaké
  // prístupné meno — viditeľný text ostáva "Odkaz na dodávateľa". issue 72:
  // samotný variantName ešte nestačí — dva riadky toho istého produktu v
  // rôznych veľkostiach majú rovnaký variantName, líšia sa len variantCode —
  // preto ho aria-label musí niesť tiež.
  const odkaz = within(bunka).getByRole<HTMLAnchorElement>("link", {
    name: `Odkaz na dodávateľa — ${LINE_STARA.variantName} (${LINE_STARA.variantCode})`,
  });
  expect(odkaz.getAttribute("href")).toBe("https://www.huntingshop.eu/wild-t-green-nohavice");
  expect(odkaz.getAttribute("rel")).toBe("noreferrer noopener");
  expect(bunka.textContent).toContain("OB832");
});

// issue 72: dva riadky TOHO ISTÉHO produktu v DVOCH rôznych veľkostiach majú
// zhodný variantName — bez variantCode v aria-labeli by mali identické
// prístupné meno a čítačka obrazovky by ich nevedela rozlíšiť.
it("dva riadky rovnakého produktu v rôznych veľkostiach majú odlišné prístupné mená odkazu", async () => {
  const velkostS = {
    ...LINE_STARA,
    lineId: "33333333-3333-3333-3333-333333333333",
    variantCode: "A-1/S",
    sizeLabel: "S",
    supplierUrl: "https://www.huntingshop.eu/nohavice-s",
    supplierNote: "https://www.huntingshop.eu/nohavice-s",
  };
  const velkostM = {
    ...LINE_STARA,
    lineId: "44444444-4444-4444-4444-444444444444",
    variantCode: "A-1/M",
    sizeLabel: "M",
    supplierUrl: "https://www.huntingshop.eu/nohavice-m",
    supplierNote: "https://www.huntingshop.eu/nohavice-m",
  };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [velkostS, velkostM], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const bunkaS = await screen.findByTestId(`supplier-link-${velkostS.lineId}`);
  const bunkaM = await screen.findByTestId(`supplier-link-${velkostM.lineId}`);
  const odkazS = within(bunkaS).getByRole<HTMLAnchorElement>("link", {
    name: `Odkaz na dodávateľa — ${velkostS.variantName} (${velkostS.variantCode})`,
  });
  const odkazM = within(bunkaM).getByRole<HTMLAnchorElement>("link", {
    name: `Odkaz na dodávateľa — ${velkostM.variantName} (${velkostM.variantCode})`,
  });
  expect(odkazS.getAttribute("aria-label")).not.toBe(odkazM.getAttribute("aria-label"));
});

it("riadok bez odkazu, len s poznámkou (internalNote bez URL), zobrazí obyčajný text namiesto odkazu", async () => {
  const riadokBezOdkazu = { ...LINE_STARA, supplierUrl: null, supplierNote: "Soxland", externalCode: null };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [riadokBezOdkazu], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const bunka = await screen.findByTestId(`supplier-link-${LINE_STARA.lineId}`);
  expect(within(bunka).queryByRole("link", { name: "Odkaz na dodávateľa" })).toBeNull();
  expect(bunka.textContent).toContain("Soxland");
});

it("riadok bez akéhokoľvek údaja o dodávateľovi zobrazí pomlčku", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const bunka = await screen.findByTestId(`supplier-link-${LINE_STARA.lineId}`);
  expect(bunka.textContent).toBe("—");
});

// issue 70 (code review nález po PR 69): pomlčka sa doteraz potláčala len
// vtedy, keď bol vyplnený `supplierUrl` alebo `supplierNote` — riadok LEN s
// `externalCode` (bez odkazu aj bez poznámky) dostal zbytočnú pomlčku hneď
// vedľa kódu.
it("riadok len s kódom dodávateľa (bez odkazu aj poznámky) nezobrazí pomlčku", async () => {
  const riadokLenSKodom = { ...LINE_STARA, supplierUrl: null, supplierNote: null, externalCode: "OB832" };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [riadokLenSKodom], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const bunka = await screen.findByTestId(`supplier-link-${LINE_STARA.lineId}`);
  expect(bunka.textContent).not.toContain("—");
  expect(bunka.textContent).toContain("OB832");
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchOpenOrders.mockRejectedValue(new OrdersUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrdersSection role="citanie" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keď načítanie zlyhá inou chybou, zobrazí vlastnú slovenskú hlášku", async () => {
  fetchOpenOrders.mockRejectedValue(new Error("network"));

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Otvorené objednávky sa nepodarilo načítať.");
  });
});

// #25: zmena stavu riadku — rola "sef" ostáva na čistom texte, presne ako
// "citanie" vyššie (rovnaká brána ako server, žiadny select pre neprivilegovanú rolu).
it("rola sef nevidí select na zmenu stavu, len text", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="sef" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(screen.queryByTestId(`state-select-${LINE_STARA.lineId}`)).toBeNull();
});

it("rola manazer vidí select a zmena stavu sa prejaví lokálne bez nového načítania", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineState.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const select = await screen.findByTestId<HTMLSelectElement>(`state-select-${LINE_STARA.lineId}`);
  expect(select.value).toBe("objednane");

  select.value = "skladom";
  select.dispatchEvent(new Event("change", { bubbles: true }));

  await waitFor(() => {
    expect(updateOrderLineState).toHaveBeenCalledWith(LINE_STARA.lineId, "skladom");
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLSelectElement>(`state-select-${LINE_STARA.lineId}`).value).toBe("skladom");
  });
  // Presne JEDNO volanie fetchOpenOrders (počiatočné načítanie) — úspešná
  // zmena aktualizuje lokálny stav, netreba refetch.
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("zlyhaná zmena stavu zobrazí slovenskú hlášku zo servera a stav sa nezmení", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineState.mockRejectedValue(new Error("Riadok objednávky sa nenašiel"));

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const select = await screen.findByTestId<HTMLSelectElement>(`state-select-${LINE_STARA.lineId}`);
  select.value = "skladom";
  select.dispatchEvent(new Event("change", { bubbles: true }));

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Riadok objednávky sa nenašiel");
  });
  expect(screen.getByTestId<HTMLSelectElement>(`state-select-${LINE_STARA.lineId}`).value).toBe("objednane");
});

it("zmena stavu pri 401 zavolá onSessionExpired namiesto zobrazenia chyby", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineState.mockRejectedValue(new OrdersUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrdersSection role="manazer" onSessionExpired={onSessionExpired} />);

  const select = await screen.findByTestId<HTMLSelectElement>(`state-select-${LINE_STARA.lineId}`);
  select.value = "skladom";
  select.dispatchEvent(new Event("change", { bubbles: true }));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

// issue 60: odškrtávacie políčko "objednané u dodávateľa" — per riadok aj
// hromadne pre celú skupinu.

it("rola citanie vidí políčko objednané ako needitovateľné", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const checkbox = await screen.findByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`);
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(true);
});

it("manažér odškrtne riadok ako objednaný, riadok sa vizuálne stlmí bez nového načítania", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineOrdered.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const checkbox = await screen.findByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`);
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(false);

  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(updateOrderLineOrdered).toHaveBeenCalledWith(LINE_STARA.lineId, true);
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`).checked).toBe(true);
  });
  expect(screen.getByTestId(`order-line-${LINE_STARA.lineId}`).className).toContain("ordered");
  // Presne JEDNO volanie fetchOpenOrders (počiatočné načítanie) — lokálna
  // aktualizácia, žiadny refetch.
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("zlyhaná zmena príznaku objednané zobrazí slovenskú hlášku a checkbox sa nezmení", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineOrdered.mockRejectedValue(new Error("Zmena príznaku objednané sa nepodarila"));

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const checkbox = await screen.findByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`);
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Zmena príznaku objednané sa nepodarila");
  });
  expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`).checked).toBe(false);
});

it("manažér označí celú skupinu dodávateľa naraz, tlačidlo sa prepne na zrušenie", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA, LINE_NOVA], email: null },
  ]);
  setSupplierLinesOrdered.mockResolvedValue({ lineCount: 2 });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const oznacit = await screen.findByRole("button", { name: "✔ Označiť skupinu ako objednané" });
  fireEvent.click(oznacit);

  await waitFor(() => {
    expect(setSupplierLinesOrdered).toHaveBeenCalledWith("Dodávateľ Alfa", true);
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`).checked).toBe(true);
  });
  expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_NOVA.lineId}`).checked).toBe(true);

  // Skupina je teraz celá objednaná — tlačidlo prepína OPAČNÝM smerom.
  const zrusit = await screen.findByRole("button", { name: "↺ Zrušiť označenie skupiny" });
  setSupplierLinesOrdered.mockResolvedValue({ lineCount: 2 });
  fireEvent.click(zrusit);

  await waitFor(() => {
    expect(setSupplierLinesOrdered).toHaveBeenCalledWith("Dodávateľ Alfa", false);
  });
});

// Review of PR 75, finding 6: per-riadkový checkbox bol doteraz disabled LEN
// cez `busyOrderedLineId` (vlastný per-riadkový zápis) — nie aj počas
// hromadnej "označiť skupinu" akcie PRE TEN ISTÝ dodávateľ
// (`busyOrderedSupplier` v `OrdersSection.tsx`). Súbežný per-riadkový klik
// počas ešte prebiehajúceho hromadného zápisu nechal optimistický UI na
// krátko nekonzistentný (posledný zápis vyhrá, žiadna strata dát, ale
// zmätočné UX).
it("riadok checkbox je disabled počas hromadnej akcie pre jeho dodávateľa, po jej dokončení sa znova sprístupní", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA, LINE_NOVA], email: null },
  ]);
  let resolveBulk: ((value: { lineCount: number }) => void) | undefined;
  setSupplierLinesOrdered.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveBulk = resolve;
      }),
  );

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const oznacit = await screen.findByRole("button", { name: "✔ Označiť skupinu ako objednané" });
  const checkboxStara = await screen.findByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`);
  expect(checkboxStara.disabled).toBe(false);

  fireEvent.click(oznacit);

  // Kým hromadný zápis ešte beží, OBIDVA riadky tohto dodávateľa musia byť
  // needitovateľné — nielen ten, na ktorý by manažér prípadne klikol zvlášť.
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`).disabled).toBe(true);
  });
  expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_NOVA.lineId}`).disabled).toBe(true);

  resolveBulk?.({ lineCount: 2 });

  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`).disabled).toBe(false);
  });
  expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_NOVA.lineId}`).disabled).toBe(false);
});

// #31: e-mailový kontakt dodávateľa + odoslanie objednávky mailom.

it("rola citanie nevidí tlačidlá na úpravu e-mailu ani odoslanie mailom, len text", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(screen.queryByRole("button", { name: "Upraviť e-mail" })).toBeNull();
  expect(screen.queryByRole("button", { name: "✉️ Poslať objednávku e-mailom" })).toBeNull();
  expect(screen.queryByRole("button", { name: "📋 Kopírovať objednávku" })).toBeNull();
});

it("manažér nastaví e-mail dodávateľa cez formulár, zobrazenie sa aktualizuje bez refetchu", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  setSupplierEmail.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(screen.getByText("E-mail dodávateľa: nenastavený")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Upraviť e-mail" }));
  fireEvent.change(screen.getByLabelText("E-mail dodávateľa Dodávateľ Alfa"), {
    target: { value: "alfa@dodavatel.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Uložiť" }));

  await waitFor(() => {
    expect(setSupplierEmail).toHaveBeenCalledWith("Dodávateľ Alfa", "alfa@dodavatel.example");
  });
  await waitFor(() => {
    expect(screen.getByText("E-mail dodávateľa: alfa@dodavatel.example")).toBeTruthy();
  });
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
});

it("bez e-mailu je tlačidlo na odoslanie mailom disabled s vysvetlením", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const tlacidlo = await screen.findByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  expect(tlacidlo.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa.")).toBeTruthy();
});

it("s e-mailom a otvorenou položkou manažér otvorí náhľad, potvrdí a mail sa odošle", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: "alfa@dodavatel.example" },
  ]);
  fetchSupplierOrderMailPreview.mockResolvedValue({
    supplier: "Dodávateľ Alfa",
    to: "alfa@dodavatel.example",
    subject: "Objednávka — Dodávateľ Alfa (1 položka)",
    body: "Objednávka — Dodávateľ Alfa (1 položka)\nA-1 | 3XL | 2 ks",
    itemCount: 1,
  });
  sendSupplierOrderMail.mockResolvedValue({ ok: true });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const posluTlacidlo = await screen.findByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  expect(posluTlacidlo.hasAttribute("disabled")).toBe(false);
  fireEvent.click(posluTlacidlo);

  await waitFor(() => {
    expect(fetchSupplierOrderMailPreview).toHaveBeenCalledWith("Dodávateľ Alfa");
  });
  const nahlad = await screen.findByTestId("mail-preview-Dodávateľ Alfa");
  expect(nahlad.textContent).toContain("alfa@dodavatel.example");
  expect(nahlad.textContent).toContain("Objednávka — Dodávateľ Alfa (1 položka)");

  fireEvent.click(screen.getByRole("button", { name: "Odoslať" }));

  await waitFor(() => {
    expect(sendSupplierOrderMail).toHaveBeenCalledWith("Dodávateľ Alfa");
  });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("odoslaná");
  });
  expect(screen.queryByTestId("mail-preview-Dodávateľ Alfa")).toBeNull();
});

it("kopírovanie objednávky do schránky použije text náhľadu", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: "alfa@dodavatel.example" },
  ]);
  fetchSupplierOrderMailPreview.mockResolvedValue({
    supplier: "Dodávateľ Alfa",
    to: "alfa@dodavatel.example",
    subject: "Objednávka — Dodávateľ Alfa (1 položka)",
    body: "Objednávka — Dodávateľ Alfa (1 položka)\nA-1 | 3XL | 2 ks",
    itemCount: 1,
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const kopirovat = await screen.findByRole("button", { name: "📋 Kopírovať objednávku" });
  fireEvent.click(kopirovat);

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith("Objednávka — Dodávateľ Alfa (1 položka)\nA-1 | 3XL | 2 ks");
  });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("schránky");
  });
});
