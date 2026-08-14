import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 64: manažérova voľná poznámka k CELEJ objednávke. Vydelené z
// `OrdersSection.test.tsx` (rovnaký vzor ako existujúce
// `OrdersSection.ordered.test.tsx`/`OrdersSection.assignSupplier.test.tsx`
// splity, `.claude/rules/testing.md`).

const { fetchOpenOrders, fetchOrdersOverview, updateOrderComment } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn(),
  updateOrderComment: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    fetchOrdersOverview,
    updateOrderComment,
  };
});

const ORDER_ID = "dddddddd-4444-4444-4444-444444444444";

// Dva riadky TEJ ISTEJ objednávky (rovnaké `orderId`), rôzne varianty — dôkaz,
// že uloženie poznámky cez JEDEN riadok sa prejaví aj na DRUHOM (poznámka
// patrí objednávke, nie riadku).
const RIADOK_1 = {
  lineId: "11111111-4444-4444-4444-444444444444",
  orderId: ORDER_ID,
  externalOrderId: "1004",
  customerName: "Zákazník 4",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1004&src=orders",
  placedAt: "2026-07-20T00:00:00.000Z",
  variantCode: "D-1",
  variantName: "Čiapka FOREST 4001",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
  ourUrl: null,
};

const RIADOK_2 = { ...RIADOK_1, lineId: "22222222-4444-4444-4444-444444444444", variantCode: "D-2" };

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("napísanie a uloženie poznámky sa lokálne prejaví na VŠETKÝCH riadkoch tej istej objednávky", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_1, RIADOK_2], email: null }]);
  updateOrderComment.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const vstup1 = await screen.findByLabelText<HTMLInputElement>(
    `Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`,
  );
  fireEvent.change(vstup1, { target: { value: "Zavolať pred doručením" } });
  expect(vstup1.value).toBe("Zavolať pred doručením");
  fireEvent.click(
    screen.getByLabelText(`Uložiť poznámku k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`),
  );

  await waitFor(() => {
    expect(updateOrderComment).toHaveBeenCalledWith(ORDER_ID, "Zavolať pred doručením");
  });

  // Druhý riadok TEJ ISTEJ objednávky ukazuje TÚ ISTÚ poznámku, hoci
  // interakcia prebehla len na prvom riadku — dôkaz, že `changeComment`
  // v `OrdersSection.tsx` aktualizuje všetky riadky s rovnakým `orderId`.
  const vstup2 = await screen.findByLabelText<HTMLInputElement>(
    `Poznámka k objednávke ${RIADOK_2.externalOrderId} / ${RIADOK_2.variantCode}`,
  );
  await waitFor(() => {
    expect(vstup2.value).toBe("Zavolať pred doručením");
  });
  // Žiadny refetch — lokálna aktualizácia stačí (rovnaký vzor ako
  // `changeState`/`changeOrdered`, na rozdiel od `assignSupplier`).
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
});

// Code review (issue 64, pred mergom): keďže poznámka je zdieľaná naprieč
// VŠETKÝMI riadkami tej istej objednávky, uloženie cez INÝ riadok (B) tej
// istej objednávky predtým ticho PREPÍSALO nerozostavaný, ešte NEULOŽENÝ
// koncept na riadku A — `OrderLineRow.tsx`'s reset efekt na `line.comment`
// nerozlišoval "toto sa zmenilo, lebo SOM to práve JA uložil" od "toto sa
// zmenilo, lebo niekto INÝ uložil poznámku tej istej objednávky odinakiaľ".
// `isCommentDirty` guard to rieši — reset sa vynechá, kým riadok drží
// neuložený koncept.
it("nerozostavaný koncept na riadku A PREŽIJE uloženie poznámky cez riadok B tej istej objednávky", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_1, RIADOK_2], email: null }]);
  updateOrderComment.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  // Manažér rozpíše koncept na riadku A, ale NEULOŽÍ ho.
  const vstupA = await screen.findByLabelText<HTMLInputElement>(
    `Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`,
  );
  fireEvent.change(vstupA, { target: { value: "Rozpísaný, ešte neuložený koncept" } });
  expect(vstupA.value).toBe("Rozpísaný, ešte neuložený koncept");

  // Medzitým uloží INÚ poznámku cez riadok B TEJ ISTEJ objednávky.
  const vstupB = screen.getByLabelText<HTMLInputElement>(
    `Poznámka k objednávke ${RIADOK_2.externalOrderId} / ${RIADOK_2.variantCode}`,
  );
  fireEvent.change(vstupB, { target: { value: "Poznámka uložená cez riadok B" } });
  fireEvent.click(
    screen.getByLabelText(`Uložiť poznámku k objednávke ${RIADOK_2.externalOrderId} / ${RIADOK_2.variantCode}`),
  );
  await waitFor(() => {
    expect(updateOrderComment).toHaveBeenCalledWith(ORDER_ID, "Poznámka uložená cez riadok B");
  });
  // Riadok B (ten, čo reálne uložil) sa synchronizuje na uloženú hodnotu.
  await waitFor(() => {
    expect(vstupB.value).toBe("Poznámka uložená cez riadok B");
  });

  // Riadok A NEBOL uložený — jeho rozostavaný koncept musí PREŽIŤ, nesmie sa
  // ticho prepísať na hodnotu, ktorú práve uložil riadok B.
  expect(vstupA.value).toBe("Rozpísaný, ešte neuložený koncept");
});

it("prázdny vstup uloží null (vymazanie poznámky)", async () => {
  const RIADOK_S_POZNAMKOU = { ...RIADOK_1, comment: "stará poznámka" };
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_S_POZNAMKOU], email: null }]);
  updateOrderComment.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const vstup = await screen.findByLabelText<HTMLInputElement>(
    `Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`,
  );
  expect(vstup.value).toBe("stará poznámka");
  fireEvent.change(vstup, { target: { value: "   " } });
  fireEvent.click(
    screen.getByLabelText(`Uložiť poznámku k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`),
  );

  await waitFor(() => {
    expect(updateOrderComment).toHaveBeenCalledWith(ORDER_ID, null);
  });
});

it("zlyhané uloženie poznámky zobrazí slovenskú hlášku, bez refetchu", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_1], email: null }]);
  updateOrderComment.mockRejectedValue(new Error("Uloženie poznámky sa nepodarilo"));

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const vstup = await screen.findByLabelText<HTMLInputElement>(
    `Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`,
  );
  fireEvent.change(vstup, { target: { value: "pokus" } });
  fireEvent.click(
    screen.getByLabelText(`Uložiť poznámku k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`),
  );

  // issue 66: kumulatívny banner nahrádza pôvodný jediný `<p role="alert">`.
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(
      "⚠️ Nepodarilo sa uložiť 1 položku×Poznámka k objednávke — obj. 1004 (Uloženie poznámky sa nepodarilo)",
    );
  });
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
});

it("rola citanie vidí poznámku len na čítanie, bez vstupného poľa", async () => {
  const RIADOK_S_POZNAMKOU = { ...RIADOK_1, comment: "Zavolať pred doručením" };
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_S_POZNAMKOU], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId(`comment-cell-${RIADOK_1.lineId}`);
  expect(screen.getByTestId(`comment-cell-${RIADOK_1.lineId}`).textContent).toBe("Zavolať pred doručením");
  expect(
    screen.queryByLabelText(`Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`),
  ).toBeNull();
});

// issue 150: pole je odteraz `<textarea>` — obyčajný Enter musí vložiť nový
// riadok (nesmie uložiť), uloží len Ctrl/⌘+Enter.
it("Enter v poznámke vloží nový riadok a NEUloží (žiadne volanie updateOrderComment)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_1], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const vstup = await screen.findByLabelText<HTMLTextAreaElement>(
    `Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`,
  );
  expect(vstup.tagName).toBe("TEXTAREA");
  fireEvent.change(vstup, { target: { value: "prvý riadok\ndruhý riadok" } });
  fireEvent.keyDown(vstup, { key: "Enter" });

  expect(vstup.value).toBe("prvý riadok\ndruhý riadok");
  expect(updateOrderComment).not.toHaveBeenCalled();
});

it("Ctrl+Enter v poznámke uloží viacriadkový text", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_1], email: null }]);
  updateOrderComment.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const vstup = await screen.findByLabelText<HTMLTextAreaElement>(
    `Poznámka k objednávke ${RIADOK_1.externalOrderId} / ${RIADOK_1.variantCode}`,
  );
  fireEvent.change(vstup, { target: { value: "prvý riadok\ndruhý riadok" } });
  fireEvent.keyDown(vstup, { key: "Enter", ctrlKey: true });

  await waitFor(() => {
    expect(updateOrderComment).toHaveBeenCalledWith(ORDER_ID, "prvý riadok\ndruhý riadok");
  });
});
