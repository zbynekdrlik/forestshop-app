import { expect, it, vi } from "vitest";
import {
  OrdersUnauthorizedError,
  assignOrderLineSupplier,
  fetchOpenOrders,
  fetchOpenStatusesConfig,
  fetchSupplierOrderMailPreview,
  saveOpenStatuses,
  sendSupplierOrderMail,
  setSupplierEmail,
  setSupplierLinesOrdered,
  triggerOrdersIngest,
  updateOrderComment,
  updateOrderLineOrdered,
  updateOrderLineState,
} from "./ordersApi.js";

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
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
};

it("prečíta otvorené objednávky zoskupené podľa dodávateľa, vrátane e-mailu dodávateľa", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ suppliers: [{ supplier: "Dodávateľ Alfa", lines: [LINE], email: "alfa@example.com" }] }),
          { status: 200 },
        ),
      ),
  );
  await expect(fetchOpenOrders()).resolves.toEqual([
    { supplier: "Dodávateľ Alfa", lines: [LINE], email: "alfa@example.com" },
  ]);
});

it("odmietne odpoveď s neplatným tvarom", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ suppliers: [{ supplier: "X", lines: [{ ...LINE, quantity: "1" }], email: null }] }),
          { status: 200 },
        ),
      ),
  );
  await expect(fetchOpenOrders()).rejects.toThrow();
});

// issue 70 (code review nález po PR 69): `href` bezpečnosť by nemala
// závisieť LEN od backendovho `extractSupplierLink` regexu — schéma na
// strane frontendu overuje, že `supplierUrl` je naozaj http(s) odkaz.
it("odmietne odpoveď, kde supplierUrl nezačína http(s)://", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          suppliers: [{ supplier: "X", lines: [{ ...LINE, supplierUrl: "javascript:alert(1)" }], email: null }],
        }),
        { status: 200 },
      ),
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

// issue 60: odškrtávacie políčko "objednané u dodávateľa".
it("updateOrderLineOrdered pošle POST na správnu trasu s telom { ordered }", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ordered: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await updateOrderLineOrdered("11111111-1111-1111-1111-111111111111", true);

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/lines/11111111-1111-1111-1111-111111111111/ordered",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ordered: true }),
    }),
  );
});

it("updateOrderLineOrdered pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(updateOrderLineOrdered("11111111-1111-1111-1111-111111111111", true)).rejects.toBeInstanceOf(
    OrdersUnauthorizedError,
  );
});

// issue 89 (review PR 87), nález 4: doteraz žiadny test tohto súboru
// nevolal `assignOrderLineSupplier` — tvrdenie "netreba meniť frontend,
// slovenská hláška prejde sama" nebolo ničím kryté.
it("assignOrderLineSupplier pošle POST na správnu trasu s telom { supplier }", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, supplier: "Alfa" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await assignOrderLineSupplier("11111111-1111-1111-1111-111111111111", "Alfa");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/lines/11111111-1111-1111-1111-111111111111/supplier",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ supplier: "Alfa" }),
    }),
  );
});

it("assignOrderLineSupplier pri 409 (produkt už má dodávateľa) vyhodí Error so slovenskou hláškou z tela odpovede", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Produkt už má dodávateľa v katalógu — ručné priradenie nie je možné" }), {
        status: 409,
      }),
    ),
  );
  await expect(assignOrderLineSupplier("11111111-1111-1111-1111-111111111111", "Konkurenčný Zápis")).rejects.toThrow(
    "Produkt už má dodávateľa v katalógu — ručné priradenie nie je možné",
  );
});

it("assignOrderLineSupplier pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(
    assignOrderLineSupplier("11111111-1111-1111-1111-111111111111", "Alfa"),
  ).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});

// issue 64: manažérova voľná poznámka k CELEJ objednávke.
it("updateOrderComment pošle PUT na správnu trasu s telom { comment }", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, comment: "Zavolať" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await updateOrderComment("22222222-2222-2222-2222-222222222222", "Zavolať");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/22222222-2222-2222-2222-222222222222/comment",
    expect.objectContaining({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "Zavolať" }),
    }),
  );
});

it("updateOrderComment posiela null ako prázdny reťazec (server ho mapuje na vymazanie)", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, comment: null }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await updateOrderComment("22222222-2222-2222-2222-222222222222", null);

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/22222222-2222-2222-2222-222222222222/comment",
    expect.objectContaining({ body: JSON.stringify({ comment: "" }) }),
  );
});

it("updateOrderComment pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(
    updateOrderComment("22222222-2222-2222-2222-222222222222", "pokus"),
  ).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});

it("setSupplierLinesOrdered pošle PUT s URL-enkódovaným menom dodávateľa a vráti počet zmenených riadkov", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true, ordered: true, lineCount: 3 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(setSupplierLinesOrdered("Dodávateľ Alfa", true)).resolves.toEqual({ lineCount: 3 });

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/suppliers/Dod%C3%A1vate%C4%BE%20Alfa/order-lines/ordered",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ ordered: true }) }),
  );
});

it("setSupplierLinesOrdered zlyhá zrozumiteľne pri chybe servera", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
  await expect(setSupplierLinesOrdered("Dodávateľ Alfa", true)).rejects.toThrow(
    "Hromadné označenie skupiny sa nepodarilo",
  );
});

// #31: e-mailový kontakt dodávateľa + odoslanie objednávky mailom.

it("setSupplierEmail pošle PUT s URL-enkódovaným menom dodávateľa a telom { email }", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, email: "a@b.sk" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await setSupplierEmail("Dodávateľ Alfa", "a@b.sk");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/suppliers/Dod%C3%A1vate%C4%BE%20Alfa/email",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ email: "a@b.sk" }) }),
  );
});

it("setSupplierEmail s null pošle prázdny reťazec (zmazanie kontaktu)", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, email: null }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await setSupplierEmail("Dodávateľ Alfa", null);

  expect(fetchMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ body: JSON.stringify({ email: "" }) }),
  );
});

it("fetchSupplierOrderMailPreview prečíta náhľad predmetu/tela/adresáta", async () => {
  const preview = { supplier: "Dodávateľ Alfa", to: "a@b.sk", subject: "Objednávka — Dodávateľ Alfa (1 položka)", body: "...", itemCount: 1 };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { status: 200 })));
  await expect(fetchSupplierOrderMailPreview("Dodávateľ Alfa")).resolves.toEqual(preview);
});

it("sendSupplierOrderMail vráti ok:true po úspešnom odoslaní", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, to: "a@b.sk", itemCount: 2 }), { status: 200 })),
  );
  await expect(sendSupplierOrderMail("Dodávateľ Alfa")).resolves.toEqual({ ok: true });
});

it("sendSupplierOrderMail vráti ok:false s hláškou, keď server odpovie ok:false (200)", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "Pre tohto dodávateľa nie je nastavený e-mail." }), { status: 200 }),
      ),
  );
  await expect(sendSupplierOrderMail("Dodávateľ Alfa")).resolves.toEqual({
    ok: false,
    error: "Pre tohto dodávateľa nie je nastavený e-mail.",
  });
});

it("sendSupplierOrderMail pri 502 (zlyhané SMTP) vráti ok:false namiesto vyhodenia výnimky", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "Odoslanie e-mailu zlyhalo. Skúste to znova o chvíľu." }), { status: 502 })),
  );
  await expect(sendSupplierOrderMail("Dodávateľ Alfa")).resolves.toEqual({
    ok: false,
    error: "Odoslanie e-mailu zlyhalo. Skúste to znova o chvíľu.",
  });
});

it("sendSupplierOrderMail pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(sendSupplierOrderMail("Dodávateľ Alfa")).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});

// #57: tlačidlo "stiahnuť teraz" na obrazovke Sync zo Shoptetu.

it("triggerOrdersIngest pošle POST na /api/orders/ingest a prečíta prijatý výsledok", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "accepted",
        orderCount: 2,
        lineCount: 3,
        skippedItemCount: 0,
        pseudoItemCount: 1,
        issueCount: 0,
        rawPath: "/data/e2e-orders-raw/x.csv.gz",
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(triggerOrdersIngest()).resolves.toEqual({
    status: "accepted",
    orderCount: 2,
    lineCount: 3,
    skippedItemCount: 0,
    pseudoItemCount: 1,
    issueCount: 0,
  });
  expect(fetchMock).toHaveBeenCalledWith("/api/orders/ingest", { method: "POST" });
});

it("triggerOrdersIngest prečíta zamietnutý výsledok", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "rejected", reason: "prázdny export" }), { status: 200 })),
  );
  await expect(triggerOrdersIngest()).resolves.toEqual({ status: "rejected", reason: "prázdny export" });
});

it("triggerOrdersIngest prečíta 'busy', keď import už beží", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "busy" }), { status: 200 })));
  await expect(triggerOrdersIngest()).resolves.toEqual({ status: "busy" });
});

it("triggerOrdersIngest pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(triggerOrdersIngest()).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});

it("triggerOrdersIngest zlyhá zrozumiteľne, keď export nie je nakonfigurovaný (503)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Import objednávok nie je nakonfigurovaný (chýba SHOPTET_ORDERS_URL)" }), {
        status: 503,
      }),
    ),
  );
  await expect(triggerOrdersIngest()).rejects.toThrow("Import objednávok nie je nakonfigurovaný");
});

// issue 59: nastavenie otvorených stavov objednávok.

it("fetchOpenStatusesConfig prečíta nastavené aj distinct videné stavy", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statuses: ["Vybavuje sa"], knownStatuses: ["Vybavená", "Vybavuje sa"] }), {
        status: 200,
      }),
    ),
  );
  await expect(fetchOpenStatusesConfig()).resolves.toEqual({
    statuses: ["Vybavuje sa"],
    knownStatuses: ["Vybavená", "Vybavuje sa"],
  });
});

it("fetchOpenStatusesConfig pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(fetchOpenStatusesConfig()).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});

it("saveOpenStatuses pošle PUT s telom { statuses } a vráti očistený zoznam zo servera", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true, statuses: ["Vybavuje sa", "Osob. odber"] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(saveOpenStatuses(["  Vybavuje sa  ", "Osob. odber"])).resolves.toEqual(["Vybavuje sa", "Osob. odber"]);

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/orders/open-statuses",
    expect.objectContaining({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statuses: ["  Vybavuje sa  ", "Osob. odber"] }),
    }),
  );
});

it("saveOpenStatuses pri prázdnom zozname (400) vráti slovenskú hlášku z tela odpovede", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Zoznam stavov nesmie ostať prázdny — musí obsahovať aspoň jeden stav." }), {
        status: 400,
      }),
    ),
  );
  await expect(saveOpenStatuses([])).rejects.toThrow("Zoznam stavov nesmie ostať prázdny");
});

it("saveOpenStatuses pri 401 vyhodí OrdersUnauthorizedError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
  await expect(saveOpenStatuses(["Vybavuje sa"])).rejects.toBeInstanceOf(OrdersUnauthorizedError);
});
