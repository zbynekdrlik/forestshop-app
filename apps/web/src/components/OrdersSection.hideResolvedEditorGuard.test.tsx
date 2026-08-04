import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 149 — riadok s otvorenou/rozpísanou úpravou (komentár alebo ručné
// priradenie mena dodávateľa) nesmie zmiznúť spod rúk, keď sa medzitým
// označí za vybavené a "skryť vybavené" je zapnuté. Vlastný súbor (rovnaký
// vzor ako existujúce `OrdersSection.ordered.test.tsx`/`.comment.test.tsx`
// splity, `.claude/rules/testing.md`) — Playwright e2e (`orders-hidden-
// editor.spec.ts`) pokrýva TRETÍ editor (odkaz na dodávateľa, toggle
// open/close) end-to-end cez skutočný prehliadač.

const { fetchOpenOrders, fetchOrdersOverview, updateOrderComment, updateOrderLineOrdered } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn(),
  updateOrderComment: vi.fn(),
  updateOrderLineOrdered: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview, updateOrderComment, updateOrderLineOrdered };
});

const LINE = {
  lineId: "11111111-1111-1111-1111-111111111149",
  orderId: "aaaaaaaa-1111-1111-1111-111111111149",
  externalOrderId: "4001",
  customerName: "Zákazník Rozpísaný",
  comment: "pôvodná poznámka",
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=4001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "R-1",
  variantName: "Produkt Rozpísaný",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it("riadok s rozpísaným (neuloženým) komentárom ostáva viditeľný, keď sa medzitým označí za vybavené pri zapnutom 'skryť vybavené' — a zmizne až po uložení", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE], email: null }]);
  updateOrderLineOrdered.mockResolvedValue(undefined);
  updateOrderComment.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  // Zapnúť "skryť vybavené" — riadok je zatiaľ NEVYBAVENÝ, ostáva viditeľný.
  fireEvent.click(await screen.findByTestId("orders-hide-resolved-toggle"));
  await screen.findByTestId(`order-line-${LINE.lineId}`);

  // Manažér rozpíše komentár, ale ešte ho NEULOŽÍ.
  const komentar = screen.getByTestId<HTMLTextAreaElement>(`comment-input-${LINE.lineId}`);
  fireEvent.change(komentar, { target: { value: "rozpísaný, ešte neuložený text" } });

  // Medzitým sa riadok označí za vybavené ("objednané u dodávateľa").
  fireEvent.click(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE.lineId}`));
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE.lineId}`).checked).toBe(true);
  });

  // Riadok je TERAZ vybavený + "skryť vybavené" je zapnuté — bez výnimky by
  // zmizol. Musí ostať viditeľný, kým editor drží rozpísaný text.
  expect(screen.queryByTestId(`order-line-${LINE.lineId}`)).not.toBeNull();
  expect(komentar.value).toBe("rozpísaný, ešte neuložený text");

  // Uloženie komentára vyčistí "dirty" príznak — riadok teraz zmizne.
  fireEvent.click(screen.getByTestId(`comment-save-${LINE.lineId}`));
  await waitFor(() => {
    expect(updateOrderComment).toHaveBeenCalledWith(LINE.orderId, "rozpísaný, ešte neuložený text");
  });
  await waitFor(() => {
    expect(screen.queryByTestId(`order-line-${LINE.lineId}`)).toBeNull();
  });
});

it("riadok s rozpísaným (neuloženým) ručným priradením dodávateľa ostáva viditeľný pri zapnutom 'skryť vybavené'", async () => {
  const riadokPriraditelny = { ...LINE, supplierAssignable: true };
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [riadokPriraditelny], email: null }]);
  updateOrderLineOrdered.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  fireEvent.click(await screen.findByTestId("orders-hide-resolved-toggle"));
  await screen.findByTestId(`order-line-${riadokPriraditelny.lineId}`);

  const priradenieVstup = screen.getByTestId<HTMLInputElement>(`supplier-assign-input-${riadokPriraditelny.lineId}`);
  fireEvent.change(priradenieVstup, { target: { value: "Nový Dodávateľ" } });

  fireEvent.click(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${riadokPriraditelny.lineId}`));
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${riadokPriraditelny.lineId}`).checked).toBe(true);
  });

  expect(screen.queryByTestId(`order-line-${riadokPriraditelny.lineId}`)).not.toBeNull();

  // Vyprázdnenie konceptu (zhoda s prázdnym/uloženým stavom) vyčistí "dirty".
  fireEvent.change(priradenieVstup, { target: { value: "" } });
  await waitFor(() => {
    expect(screen.queryByTestId(`order-line-${riadokPriraditelny.lineId}`)).toBeNull();
  });
});
