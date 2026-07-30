import { expect, it, vi } from "vitest";
import { PairingUnauthorizedError, confirmPairing, searchPairings } from "./pairingApi.js";

it("zloží dopyt na hľadanie z parametrov", async () => {
  const spy = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 }));
  vi.stubGlobal("fetch", spy);

  await searchPairings({ q: "40237/3XL", state: "navrhnute", page: 2 });

  expect(spy).toHaveBeenCalledWith("/api/pairing?q=40237%2F3XL&state=navrhnute&page=2&pageSize=50");
});

it("prečíta zoznam párovania", async () => {
  const telo = {
    total: 1,
    items: [
      {
        variantCode: "40237/3XL",
        variantName: "Nohavice FOREST 1003",
        sizeLabel: "3XL",
        productSupplier: "GRUBE",
        supplierUrl: null,
        state: "navrhnute" as const,
        confirmedByName: null,
        confirmedAt: null,
      },
    ],
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(telo), { status: 200 })));
  await expect(searchPairings({ q: "", state: "all", page: 1 })).resolves.toEqual(telo);
});

it("odmietne odpoveď s neplatným tvarom", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: "veľa", items: [] }), { status: 200 })),
  );
  await expect(searchPairings({ q: "", state: "all", page: 1 })).rejects.toThrow();
});

it("pri 401 vyhodí PairingUnauthorizedError namiesto všeobecnej chyby", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(searchPairings({ q: "", state: "all", page: 1 })).rejects.toBeInstanceOf(
    PairingUnauthorizedError,
  );
});

it("zlyhá zrozumiteľne pri chybe servera", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(searchPairings({ q: "", state: "all", page: 1 })).rejects.toThrow(
    "Zoznam párovania sa nepodarilo načítať",
  );
});

it("potvrdenie BEZ ručnej adresy odošle telo bez poľa supplierUrl (potvrdí uloženú adresu)", async () => {
  const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", spy);

  await confirmPairing("40237/3XL");

  const volanie = spy.mock.calls[0] as [string, RequestInit];
  expect(volanie[0]).toBe("/api/pairing/confirm");
  expect(JSON.parse(volanie[1].body as string)).toEqual({ variantCode: "40237/3XL" });
});

it("potvrdenie S ručnou adresou pošle supplierUrl v tele", async () => {
  const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", spy);

  await confirmPairing("40237/3XL", "https://www.grube.sk/p/1");

  const volanie = spy.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(volanie[1].body as string)).toEqual({
    variantCode: "40237/3XL",
    supplierUrl: "https://www.grube.sk/p/1",
  });
});

it("odovzdá hlásenie servera namiesto všeobecnej hlášky, keď ho server pošle", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Chýba adresa produktu u dodávateľa" }), { status: 400 })),
  );
  await expect(confirmPairing("40237/3XL")).rejects.toThrow("Chýba adresa produktu u dodávateľa");
});
