import { expect, it, vi } from "vitest";
import { OrdersUnauthorizedError, fetchOpenOrders, updateOrderLineState } from "./ordersApi.js";

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

// #25: zmena stavu riadku objednávky.
it("updateOrderLineState pošle POST na správnu trasu s telom { state }", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, state: "skladom" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await updateOrderLineState("11111111-1111-1111-1111-111111111111", "skladom");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/lines/11111111-1111-1111-1111-111111111111/state",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "skladom" }),
    }),
  );
});

it("updateOrderLineState pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(updateOrderLineState("11111111-1111-1111-1111-111111111111", "skladom")).rejects.toBeInstanceOf(
    OrdersUnauthorizedError,
  );
});

it("updateOrderLineState pri chybe servera vráti slovenskú hlášku z tela odpovede", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Riadok objednávky sa nenašiel" }), { status: 404 })),
  );
  await expect(updateOrderLineState("11111111-1111-1111-1111-111111111111", "skladom")).rejects.toThrow(
    "Riadok objednávky sa nenašiel",
  );
});

it("updateOrderLineState bez tela odpovede použije všeobecnú hlášku", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(updateOrderLineState("11111111-1111-1111-1111-111111111111", "skladom")).rejects.toThrow(
    "Zmena stavu sa nepodarila",
  );
});
