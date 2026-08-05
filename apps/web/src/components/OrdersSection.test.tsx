import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// `updateOrderLineOrdered`/`setSupplierLinesOrdered` mocks moved to
// `OrdersSection.ordered.test.tsx` alongside the tests that actually
// exercise them (review of PR 75, finding 6 — same file split). issue 118:
// `fetchSupplierOrderMailPreview`/`sendSupplierOrderMail` mocks moved to
// `OrdersSection.mailActions.test.tsx` the same way — this file no longer
// has any test exercising the (now hidden-by-default) mail preview/send
// flow.
const { fetchOpenOrders, fetchOrdersOverview, updateOrderLineState, setSupplierEmail } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn(),
  updateOrderLineState: vi.fn(),
  setSupplierEmail: vi.fn(),
}));

// `OrdersUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu — rovnaký
// dôvod ako `SchedulerSection.test.tsx`'s `SchedulerUnauthorizedError`:
// `instanceof` v komponente musí fungovať aj v teste.
vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    fetchOrdersOverview,
    updateOrderLineState,
    setSupplierEmail,
  };
});

const { OrdersUnauthorizedError } = await import("../ordersApi.js");

const LINE_STARA = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník Starý",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
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
  supplierAssignable: false,
  manualSupplierOverride: null,
  ourUrl: null,
};

const LINE_NOVA = {
  lineId: "22222222-2222-2222-2222-222222222222",
  orderId: "bbbbbbbb-2222-2222-2222-222222222222",
  externalOrderId: "1002",
  customerName: "Zákazník Nový",
  comment: "Zavolať pred doručením",
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1002&src=orders",
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
  supplierAssignable: false,
  manualSupplierOverride: null,
  ourUrl: null,
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

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
  expect(novy.textContent).toContain("Bunda FOREST 2001");
  expect(novy.textContent).toContain("Skladom");
  expect(novy.textContent).toContain("Zavolať pred doručením");

  const stary = screen.getByTestId(`order-line-${LINE_STARA.lineId}`);
  // issue 60: východiskový stav "objednane" sa teraz volá "Nevybavené" — slovo
  // "Objednané" je odteraz VÝLUČNE nové odškrtávacie políčko, nie tento stav.
  expect(stary.textContent).toContain("Nevybavené");
});

// issue 95: 13 pôvodných stĺpcov → 10 (VEĽKOSŤ zlúčená do KÓD, PRIRADENIE
// DODÁVATEĽA do DODÁVATEĽ, POZNÁMKA E-SHOPU do POZNÁMOK) — regresný test
// dokazuje, že ide o SKUTOČNÉ zlúčenie stĺpcov v DOM-e (rovnaký rodičovský
// `<td>`), nie len premenovanie hlavičiek. issue 117: KÓD (variant kódu)
// stĺpec celý zrušený (majiteľ, "kody produktov vobec nepouzivame") — 10 → 9.
it("hlavička tabuľky má 9 stĺpcov (KÓD zrušený, zlúčené VEĽKOSŤ/PRIRADENIE DODÁVATEĽA/POZNÁMKA E-SHOPU)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const hlavicky = await screen.findAllByRole("columnheader");
  expect(hlavicky).toHaveLength(9);
  const nazvy = hlavicky.map((th) => th.textContent);
  expect(nazvy).not.toContain("Veľkosť");
  expect(nazvy).not.toContain("Priradenie dodávateľa");
  expect(nazvy).not.toContain("Poznámka e-shopu");
  expect(nazvy).not.toContain("Kód");
});

it("zlúčená bunka DODÁVATEĽ drží odkaz na dodávateľa AJ priradenie v tom istom stĺpci", async () => {
  // issue 107 bod 3: `.ord-supplier-assign` sa už nevykresľuje pre
  // neradiťeľné riadky (`LINE_STARA` má `supplierAssignable: false`) —
  // tento test overuje SKUTOČNÝ DOM zlúčenie (ten istý rodičovský `<td>`),
  // preto potrebuje riadok, kde sa blok priradenia vôbec vykreslí.
  const riadokRaditelny = { ...LINE_STARA, supplierAssignable: true };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [riadokRaditelny], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const odkazBunka = await screen.findByTestId(`supplier-link-${riadokRaditelny.lineId}`);
  const priradenieBunka = await screen.findByTestId(`supplier-assign-cell-${riadokRaditelny.lineId}`);
  expect(odkazBunka.closest("td")).toBe(priradenieBunka.closest("td"));
});

it("zlúčená bunka POZNÁMKY drží poznámku e-shopu AJ komentár v tom istom stĺpci", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const shopRemarkBunka = await screen.findByTestId(`shop-remark-cell-${LINE_STARA.lineId}`);
  const commentBunka = await screen.findByTestId(`comment-cell-${LINE_STARA.lineId}`);
  expect(shopRemarkBunka.closest("td")).toBe(commentBunka.closest("td"));
});

// issue 171: zákaznícka poznámka (🛈, `remark`) sa presunula do bunky
// PRODUKTU — táto bunka NIE JE tá istá ako zlúčená bunka POZNÁMKY (`shop-
// remark-cell`/`comment-cell` vyššie), na rozdiel od pôvodného stavu, kde
// bola treťou v tom istom `td.ord-notes-merged`.
it("poznámka zákazníka je v bunke produktu, NIE v zlúčenej bunke POZNÁMKY", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const remarkBunka = await screen.findByTestId(`remark-cell-${LINE_STARA.lineId}`);
  const nazovProduktu = await screen.findByText(LINE_STARA.variantName);
  const commentBunka = await screen.findByTestId(`comment-cell-${LINE_STARA.lineId}`);
  expect(remarkBunka.closest("td")).toBe(nazovProduktu.closest("td"));
  expect(remarkBunka.closest("td")).not.toBe(commentBunka.closest("td"));
});

it("chýbajúci dodávateľ zobrazí ako pomlčku", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_NOVA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE_NOVA.lineId}`);
  // LINE_NOVA má `supplierUrl`/`supplierNote`/`externalCode`/`supplierAssignable`
  // všetky prázdne/false — pomlčka pochádza zo zlúčenej bunky DODÁVATEĽ.
  expect(riadok.textContent).toContain("—");
});

// issue 67: odkaz na tovar u dodávateľa. issue 119: viditeľný text je odteraz
// len ikonka (icon button), prístupné meno nesie výlučne `aria-label`.
it("riadok s odkazom na dodávateľa zobrazí klikateľné ikonové tlačidlo, otvárajúce v novej karte", async () => {
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
  // prístupné meno. issue 72: samotný variantName ešte nestačí — dva riadky
  // toho istého produktu v rôznych veľkostiach majú rovnaký variantName,
  // líšia sa len variantCode — preto ho aria-label musí niesť tiež.
  const odkaz = within(bunka).getByRole<HTMLAnchorElement>("link", {
    name: `Odkaz na dodávateľa — ${LINE_STARA.variantName} (${LINE_STARA.variantCode})`,
  });
  expect(odkaz.getAttribute("href")).toBe("https://www.huntingshop.eu/wild-t-green-nohavice");
  expect(odkaz.getAttribute("rel")).toBe("noreferrer noopener");
  expect(odkaz.getAttribute("target")).toBe("_blank");
  // issue 117: `externalCode` (dodávateľský kód) sa už NIKDE nezobrazuje.
  expect(bunka.textContent).not.toContain("OB832");
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

// issue 117: `externalCode` (dodávateľský kód) sa už NIKDY nezobrazuje —
// majiteľ ho nepoužíva. Riadok LEN s `externalCode` (bez odkazu, poznámky aj
// priradenia) je odteraz NEROZOZNATEĽNÝ od riadku úplne bez údajov o
// dodávateľovi — obidva zobrazia pomlčku (predtým, pred issue 117, tu kód
// potláčal pomlčku a zobrazoval sa namiesto nej).
it("riadok len s kódom dodávateľa (bez odkazu aj poznámky) zobrazí pomlčku, kód sa nezobrazí", async () => {
  const riadokLenSKodom = { ...LINE_STARA, supplierUrl: null, supplierNote: null, externalCode: "OB832" };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [riadokLenSKodom], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const bunka = await screen.findByTestId(`supplier-link-${LINE_STARA.lineId}`);
  expect(bunka.textContent).toBe("—");
  expect(bunka.textContent).not.toContain("OB832");
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

it("rola manazer vidí 4 tlačidlá a zmena stavu sa prejaví lokálne bez nového načítania", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineState.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId(`state-select-${LINE_STARA.lineId}`);
  // issue 161: `<select>`'s jedna vybraná `<option>` nahradilo `aria-checked`
  // na PRÁVE aktívnom z 4 tlačidiel.
  expect(screen.getByTestId(`state-btn-objednane-${LINE_STARA.lineId}`).getAttribute("aria-checked")).toBe("true");

  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_STARA.lineId}`));

  await waitFor(() => {
    expect(updateOrderLineState).toHaveBeenCalledWith(LINE_STARA.lineId, "skladom");
  });
  await waitFor(() => {
    expect(screen.getByTestId(`state-btn-skladom-${LINE_STARA.lineId}`).getAttribute("aria-checked")).toBe("true");
  });
  expect(screen.getByTestId(`state-btn-objednane-${LINE_STARA.lineId}`).getAttribute("aria-checked")).toBe("false");
  // Presne JEDNO volanie fetchOpenOrders (počiatočné načítanie) — úspešná
  // zmena aktualizuje lokálny stav, netreba refetch.
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

// issue 161 (code review finding): klik na UŽ aktívne tlačidlo nesmie poslať
// zbytočný zápis na server — presne to, čo pôvodný `<select>` robil (výber
// TEJ ISTEJ `<option>` nikdy nevyvolal `onChange`). Bez tohto testu by
// budúca zmena `OrderLineStateButtons.tsx`'s `if (!active)` guardu mohla
// ticho pridať zbytočné PATCH volania a nič by to nezachytilo.
it("klik na už aktívne stavové tlačidlo nezavolá updateOrderLineState", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId(`state-select-${LINE_STARA.lineId}`);
  const aktivne = screen.getByTestId(`state-btn-objednane-${LINE_STARA.lineId}`);
  expect(aktivne.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(aktivne);

  expect(updateOrderLineState).not.toHaveBeenCalled();
});

it("zlyhaná zmena stavu zobrazí slovenskú hlášku zo servera a stav sa nezmení", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineState.mockRejectedValue(new Error("Riadok objednávky sa nenašiel"));

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId(`state-select-${LINE_STARA.lineId}`);
  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_STARA.lineId}`));

  // issue 66: kumulatívny banner (nahrádza pôvodný jediný `<p role="alert">`
  // so surovou serverovou hláškou) — nesie aj nadpis "N položiek"/tlačidlo
  // "×" aj `what — where (detail)` riadok, `.claude/rules/frontend-design.md`.
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(
      "⚠️ Nepodarilo sa uložiť 1 položku×Zmena stavu — obj. 1001, kód A-1 (Riadok objednávky sa nenašiel)",
    );
  });
  expect(screen.getByTestId(`state-btn-objednane-${LINE_STARA.lineId}`).getAttribute("aria-checked")).toBe("true");
});

it("zmena stavu pri 401 zavolá onSessionExpired namiesto zobrazenia chyby", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  updateOrderLineState.mockRejectedValue(new OrdersUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrdersSection role="manazer" onSessionExpired={onSessionExpired} />);

  await screen.findByTestId(`state-select-${LINE_STARA.lineId}`);
  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_STARA.lineId}`));

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

// issue 60: odškrtávacie políčko "objednané u dodávateľa" — per riadok aj
// hromadne pre celú skupinu — vydelené do vlastného súboru
// `OrdersSection.ordered.test.tsx` (review of PR 75, finding 6 pridalo ďalší
// test a poslalo tento súbor cez eslint `max-lines: 400`,
// `.claude/rules/frontend-design.md`).

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

// issue 118: majiteľ, doslovne "zatial skry este to nebudeme pouzivat" —
// appka SKRÝVA (nemaže) "📋 Kopírovať objednávku"/"✉️ Poslať objednávku
// e-mailom" + sprievodný text, `orderScreenFlags.ts`'s
// `SHOW_ORDER_MAIL_ACTIONS` (predvolene `false`). Platí AJ pre rolu
// "manazer" (`canChangeState: true`) — na rozdiel od testu vyššie ("rola
// citanie…"), kde sú skryté z INÉHO dôvodu (žiadne op práva). Samotná
// funkcionalita (náhľad/odoslanie mailu, kopírovanie) zostáva plne
// otestovaná v `OrdersSection.mailActions.test.tsx` (flag prepnutý na
// `true` cez `vi.mock`).
it("issue 118: aj manažér (canChangeState) nevidí tlačidlá kopírovania/odoslania mailom ani sprievodný text, kým je appka skryje", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(screen.queryByRole("button", { name: "✉️ Poslať objednávku e-mailom" })).toBeNull();
  expect(screen.queryByRole("button", { name: "📋 Kopírovať objednávku" })).toBeNull();
  expect(screen.queryByText("Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa.")).toBeNull();
  // Hromadné tlačidlo (mimo issue 118's scope) ostáva viditeľné.
  expect(screen.getByRole("button", { name: "✔ Označiť skupinu ako objednané" })).toBeTruthy();
});

// issue 187: objednaná veľkosť pri mene produktu — obsluha podľa nej
// objednáva u dodávateľa. Kedysi bola vo vlastnom stĺpci VEĽKOSŤ, ten sa
// zlúčil do KÓD (issue 95) a KÓD sa celý odstránil (issue 117), čím veľkosť
// nechcene zmizla z obrazovky.
it("zobrazí objednanú veľkosť pri mene produktu, a nič pri variante bez veľkosti", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA, LINE_NOVA], email: null },
  ]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const soVelkostou = await screen.findByTestId(`size-${LINE_STARA.lineId}`);
  expect(soVelkostou.textContent).toBe(LINE_STARA.sizeLabel);

  // Riadok bez veľkosti nesmie vykresliť ANI prázdny štítok, ANI pomlčku.
  expect(LINE_NOVA.sizeLabel).toBeNull();
  expect(screen.queryByTestId(`size-${LINE_NOVA.lineId}`)).toBeNull();
});
