import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersOverviewTiles } from "./OrdersOverviewTiles.js";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";

const { fetchOrdersOverview } = vi.hoisted(() => ({ fetchOrdersOverview: vi.fn() }));

// `OrdersUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu —
// rovnaký dôvod ako `OrderOpenStatusesPanel.test.tsx`: `instanceof` v
// komponente musí fungovať aj v teste.
vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOrdersOverview };
});

const { OrdersUnauthorizedError } = await import("../ordersApi.js");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const makeLine = (overrides: Partial<OrderLine> = {}): OrderLine => ({
  lineId: overrides.lineId ?? "l1",
  orderId: overrides.orderId ?? "o1",
  externalOrderId: "1001",
  customerName: "Zákazník",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Produkt",
  sizeLabel: null,
  quantity: 1,
  state: "objednane",
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  ourUrl: null,
  ...overrides,
});

const OVERVIEW = {
  today: { orderCount: 3, revenue: "150.00" },
  week: { orderCount: 10, revenue: "980.50" },
  month: { orderCount: 42, revenue: "3120.00" },
};

it("zobrazí tri dlaždice 'Prehľad e-shopu' s počtom objednávok aj tržbou", async () => {
  fetchOrdersOverview.mockResolvedValue(OVERVIEW);
  render(<OrdersOverviewTiles suppliers={[]} onSessionExpired={() => {}} />);

  await waitFor(() => {
    // issue 237 (code review): 3 spadá do slovenského "málopočetného" (paucal)
    // tvaru 2-4 → "objednávky", nie "objednávok" (`formatOrderCount`).
    expect(screen.getByTestId("overview-shop-today").textContent).toContain("3 objednávky");
  });
  expect(screen.getByTestId("overview-shop-today").textContent).toContain("150.00 €");
  expect(screen.getByTestId("overview-shop-week").textContent).toContain("10 objednávok");
  expect(screen.getByTestId("overview-shop-week").textContent).toContain("980.50 €");
  expect(screen.getByTestId("overview-shop-month").textContent).toContain("42 objednávok");
  expect(screen.getByTestId("overview-shop-month").textContent).toContain("3120.00 €");
});

it("chyba pri načítaní prehľadu e-shopu zobrazí hlášku, nikdy nespadne", async () => {
  fetchOrdersOverview.mockRejectedValue(new Error("network"));
  render(<OrdersOverviewTiles suppliers={[]} onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Prehľad e-shopu sa nepodarilo načítať.");
  });
});

it("401 pri načítaní prehľadu e-shopu zavolá onSessionExpired", async () => {
  fetchOrdersOverview.mockRejectedValue(new OrdersUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<OrdersOverviewTiles suppliers={[]} onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

// issue 237: "Súhrn o objednávaní" — počítaný ČISTO zo `suppliers`, nezávisle
// od `fetchOrdersOverview` (ktorý tu nikdy nedobehne — dôkaz, že tento blok
// nepotrebuje sieť vôbec).
it("'Súhrn o objednávaní' počíta zo suppliers bez ohľadu na to, či prehľad e-shopu ešte dobehol", () => {
  fetchOrdersOverview.mockReturnValue(new Promise(() => {})); // nikdy sa nevyrieši
  const suppliers: readonly SupplierOpenOrders[] = [
    {
      supplier: "Dodávateľ Alfa",
      email: null,
      lines: [
        makeLine({ lineId: "a1", orderId: "oa", state: "objednane", ordered: false, placedAt: "2026-01-15T00:00:00.000Z" }),
        makeLine({ lineId: "a2", orderId: "oa", state: "objednane", ordered: false, placedAt: "2026-06-01T00:00:00.000Z" }),
        makeLine({ lineId: "a3", orderId: "ob", state: "objednane", ordered: true }), // vybavené
      ],
    },
  ];

  render(<OrdersOverviewTiles suppliers={suppliers} onSessionExpired={() => {}} />);

  // 2 nevybavené riadky (a1, a2), obe v TEJ ISTEJ objednávke "oa" → 1
  // dotknutá objednávka, 1 už objednaná (a3), najstaršia čakajúca 2026-01-15.
  expect(screen.getByTestId("overview-ordering-remaining").textContent).toContain("2");
  expect(screen.getByTestId("overview-ordering-affected-orders").textContent).toContain("1");
  expect(screen.getByTestId("overview-ordering-already-ordered").textContent).toContain("1");
  expect(screen.getByTestId("overview-ordering-oldest").textContent).toContain(
    new Date("2026-01-15T00:00:00.000Z").toLocaleDateString("sk-SK"),
  );
});

// issue 260 — majiteľ: "sú tam 2 rovnaké čelovky, ale ukazuje len jednu".
// `ingest.ts` sčíta ten istý produkt v tej istej objednávke do JEDNÉHO
// `order_line` s `quantity: 2` (`.claude/rules/orders.md`) — "Položiek na
// objednanie" preto MUSÍ ukázať súčet KUSOV (4), nie počet riadkov (2). Pred
// opravou (`summarizeOrderLines` počítala `lines.length`) by táto asercia
// zlyhala s "2" namiesto "4".
it("'Položiek na objednanie' sčíta MNOŽSTVÁ riadkov, nie ich počet", () => {
  fetchOrdersOverview.mockReturnValue(new Promise(() => {}));
  const suppliers: readonly SupplierOpenOrders[] = [
    {
      supplier: "Dodávateľ Alfa",
      email: null,
      lines: [
        makeLine({ lineId: "b1", orderId: "ob1", quantity: 2, state: "objednane", ordered: false }),
        makeLine({ lineId: "b2", orderId: "ob2", quantity: 2, state: "objednane", ordered: false }),
      ],
    },
  ];

  render(<OrdersOverviewTiles suppliers={suppliers} onSessionExpired={() => {}} />);

  expect(screen.getByTestId("overview-ordering-remaining").textContent).toContain("4");
});

it("bez žiadneho nevybaveného riadku ukáže '—' namiesto dátumu najstaršej čakajúcej", () => {
  fetchOrdersOverview.mockReturnValue(new Promise(() => {}));
  render(<OrdersOverviewTiles suppliers={[]} onSessionExpired={() => {}} />);

  expect(screen.getByTestId("overview-ordering-oldest").textContent).toContain("—");
  expect(screen.getByTestId("overview-ordering-remaining").textContent).toContain("0");
});

// issue 360 (majiteľ: "všetko v jednom riadku") — všetkých 7 dlaždíc
// ("Prehľad e-shopu" + "Súhrn o objednávaní") musí byť priamym potomkom
// TOHO ISTÉHO `.overview-tiles` kontajnera (jeden spoločný flex riadok),
// nie rozdelené do dvoch samostatných skupín ako predtým issue 237.
it("všetkých 7 súhrnných čísel je v JEDNOM spoločnom riadku, nie v dvoch oddelených skupinách", async () => {
  fetchOrdersOverview.mockResolvedValue(OVERVIEW);
  render(<OrdersOverviewTiles suppliers={[]} onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByTestId("overview-shop-today")).toBeTruthy();
  });

  const row = screen.getByTestId("overview-shop-today").parentElement;
  expect(row?.className).toBe("overview-tiles");

  const testIds = [
    "overview-shop-today",
    "overview-shop-week",
    "overview-shop-month",
    "overview-ordering-remaining",
    "overview-ordering-affected-orders",
    "overview-ordering-already-ordered",
    "overview-ordering-oldest",
  ];
  for (const testId of testIds) {
    expect(screen.getByTestId(testId).parentElement).toBe(row);
  }
  expect(row?.children.length).toBe(testIds.length);

  // Nadpisy skupín ("Prehľad e-shopu"/"Súhrn o objednávaní") sú preč.
  expect(screen.queryByText("Prehľad e-shopu")).toBeNull();
  expect(screen.queryByText("Súhrn o objednávaní")).toBeNull();
});
