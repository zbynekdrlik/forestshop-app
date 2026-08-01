import { expect, it, vi } from "vitest";
import { OrdersUnauthorizedError, setProductSupplierLink } from "./ordersApi.js";

// issue 121: manuálny odkaz na dodávateľa — vlastný súbor (nie pridané do
// `ordersApi.test.ts`, ktoré je už blízko eslint `max-lines: 400`), rovnaký
// vzor ako existujúce delenia (`.claude/rules/testing.md`).

it("setProductSupplierLink pošle POST na správnu trasu s telom { url }", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true, url: "https://dodavatel.example.com" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await setProductSupplierLink("11111111-1111-1111-1111-111111111111", "https://dodavatel.example.com");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/lines/11111111-1111-1111-1111-111111111111/supplier-link",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://dodavatel.example.com" }),
    }),
  );
});

it("setProductSupplierLink pri 400 (neplatná URL) vyhodí Error so slovenskou hláškou z tela odpovede", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Neplatná URL adresa" }), { status: 400 })),
  );
  await expect(
    setProductSupplierLink("11111111-1111-1111-1111-111111111111", "nie je url"),
  ).rejects.toThrow("Neplatná URL adresa");
});

it("setProductSupplierLink pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(
    setProductSupplierLink("11111111-1111-1111-1111-111111111111", "https://dodavatel.example.com"),
  ).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});
