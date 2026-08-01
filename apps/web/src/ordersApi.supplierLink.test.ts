import { expect, it, vi } from "vitest";
import { OrdersUnauthorizedError, setProductSupplierLink, validateSupplierLinkUrl } from "./ordersApi.js";

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

// issue 153: OKAMŽITÁ kontrola v prehliadači — zrkadlí presne rovnaké
// pravidlo ako server (`orderLineSupplierLinkBody`, `orders-routes.ts`), aby
// zamestnanec videl chybu HNEĎ, bez zbytočného round-tripu na server.
it("validateSupplierLinkUrl vráti null pre platnú http(s) adresu", () => {
  expect(validateSupplierLinkUrl("https://dodavatel.example.com/produkt")).toBeNull();
  expect(validateSupplierLinkUrl("http://dodavatel.example.com")).toBeNull();
});

it("validateSupplierLinkUrl vráti zrozumiteľnú slovenskú hlášku pre hodnotu, ktorá nie je platná URL", () => {
  expect(validateSupplierLinkUrl("nieje-url")).toBe("Odkaz musí byť platná adresa začínajúca http:// alebo https://.");
});

it("validateSupplierLinkUrl odmietne inú schému než http(s) (napr. javascript:)", () => {
  expect(validateSupplierLinkUrl("javascript:alert(1)")).toBe(
    "Odkaz musí byť platná adresa začínajúca http:// alebo https://.",
  );
});

it("validateSupplierLinkUrl odmietne adresu dlhšiu ako 2000 znakov (rovnaký strop ako server)", () => {
  const dlha = "https://example.com/" + "a".repeat(2000);
  expect(validateSupplierLinkUrl(dlha)).toBe("Odkaz musí byť platná adresa začínajúca http:// alebo https://.");
});
