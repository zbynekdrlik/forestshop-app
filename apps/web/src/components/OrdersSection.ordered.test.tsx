import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 60: odškrtávacie políčko "objednané u dodávateľa" — per riadok aj
// hromadne pre celú skupinu. Vydelené z `OrdersSection.test.tsx`, aby ani
// jeden zo súborov nenarástol cez eslint `max-lines: 400`
// (`.claude/rules/frontend-design.md`) — rovnaký vzor ako existujúci
// `orders-http.integration.test.ts` / `orders-http-state.integration.test.ts`
// split na strane API testov.

const { fetchOpenOrders, fetchOrdersOverview, updateOrderLineOrdered, setSupplierLinesOrdered } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn(),
  updateOrderLineOrdered: vi.fn(),
  setSupplierLinesOrdered: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    fetchOrdersOverview,
    updateOrderLineOrdered,
    setSupplierLinesOrdered,
  };
});

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
  customerOpenOrderCount: 1,
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
  customerOpenOrderCount: 1,
  ourUrl: null,
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

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

  // issue 66: kumulatívny banner nahrádza pôvodný jediný `<p role="alert">`.
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(
      "⚠️ Nepodarilo sa uložiť 1 položku×Príznak objednané — obj. 1001, kód A-1 (Zmena príznaku objednané sa nepodarila)",
    );
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

// Review of PR 76, finding 5: fix 6 above (PR 75, finding 6) was applied in
// only one direction — the per-row checkbox is blocked during a bulk write,
// but the group toggle button was NOT blocked while a per-row change is in
// flight for its own supplier. Scenario: A=checked, B=unchecked; manager
// unchecks A (POST A=false in flight, optimistic update lands only on
// resolve) and immediately clicks the group button — `every(l => l.ordered)`
// still reads `false` for a moment, so the bulk sends `ordered: true`; the
// bulk's `.then` paints both rows checked, then A's own per-row `.then`
// repaints A unchecked while the DB actually holds `true`. No data loss, but
// exactly the confusing-UI class the original finding targeted, mirrored.
it("skupinové tlačidlo je disabled počas per-riadkovej zmeny v tej istej skupine, po jej dokončení sa znova sprístupní", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA, LINE_NOVA], email: null },
  ]);
  let resolveRiadok: (() => void) | undefined;
  updateOrderLineOrdered.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveRiadok = resolve;
      }),
  );

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const oznacit = await screen.findByRole("button", { name: "✔ Označiť skupinu ako objednané" });
  expect(oznacit.hasAttribute("disabled")).toBe(false);

  const checkboxStara = await screen.findByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_STARA.lineId}`);
  fireEvent.click(checkboxStara);

  // Kým per-riadkový zápis pre TENTO dodávateľ ešte beží, skupinové
  // tlačidlo musí byť needitovateľné — inak by mohlo poslať hromadný zápis
  // na základe ešte-neaktualizovaného `ordered` a jeho výsledok by neskôr
  // prepísala odpoveď per-riadkového zápisu (opačné poradie ako fix 6).
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "✔ Označiť skupinu ako objednané" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  resolveRiadok?.();

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "✔ Označiť skupinu ako objednané" }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
