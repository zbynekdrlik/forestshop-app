import { expect, it, vi } from "vitest";
import { OrdersUnauthorizedError, fetchOpenOrders } from "./ordersApi.js";

const LINE = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "22222222-2222-2222-2222-222222222222",
  externalOrderId: "1002",
  customerName: "Zákazník 2",
  comment: null,
  placedAt: "2026-07-15T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Test produkt A-1",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
};

it("prečíta otvorené objednávky zoskupené podľa dodávateľa", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ suppliers: [{ supplier: "Dodávateľ Alfa", lines: [LINE] }] }), {
          status: 200,
        }),
      ),
  );
  await expect(fetchOpenOrders()).resolves.toEqual([{ supplier: "Dodávateľ Alfa", lines: [LINE] }]);
});

it("odmietne odpoveď s neplatným tvarom", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ suppliers: [{ supplier: "X", lines: [{ ...LINE, quantity: "1" }] }] }), {
          status: 200,
        }),
      ),
  );
  await expect(fetchOpenOrders()).rejects.toThrow();
});

it("pri 401 vyhodí OrdersUnauthorizedError namiesto všeobecnej chyby", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(fetchOpenOrders()).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});

it("zlyhá zrozumiteľne pri chybe servera", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(fetchOpenOrders()).rejects.toThrow("Otvorené objednávky sa nepodarilo načítať");
});
