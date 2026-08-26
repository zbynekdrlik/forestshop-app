import { z } from "zod";

// Zrkadlí `OrderLineState`/`OpenOrderLine`/`SupplierOpenOrders` z
// `apps/api/src/modules/orders/queries.ts` — vlastná zod schéma namiesto
// zdieľaného typu, rovnaký vzor ako `catalogApi.ts` (frontend a backend sú
// samostatné balíčky, žiadny zdieľaný typový balík medzi nimi (zatiaľ)
// neexistuje).
const orderLineSchema = z.object({
  lineId: z.string(),
  orderId: z.string(),
  externalOrderId: z.string(),
  customerName: z.string(),
  comment: z.string().nullable(),
  // issue 65: zákaznícky odkaz k objednávke (Shoptet export's `remark`
  // stĺpec — NIE `shopRemark`, interná poznámka predajne, `.claude/rules/
  // orders.md`). Read-only, appka ho nikdy needituje.
  remark: z.string().nullable(),
  // issue 164: INTERNÁ poznámka e-shopu — UŽ odvodená (cudzí text, appkin
  // vlastný blok nikdy neobsahuje, `apps/api`'s `extractForeignShopRemark`).
  // Read-only, appka ju nikdy needituje (nezávislé od appkinho `comment`).
  shopRemark: z.string().nullable(),
  // issue 65: priamy odkaz do Shoptet administrácie na TÚTO objednávku.
  // `.regex` je druhá vrstva overenia (rovnaký zámer ako `supplierUrl`
  // vyššie, issue 70) — `href` bezpečnosť by nemala závisieť LEN od
  // backendovho zloženia URL.
  adminUrl: z.string().regex(/^https?:\/\//),
  placedAt: z.string(),
  variantCode: z.string(),
  variantName: z.string(),
  sizeLabel: z.string().nullable(),
  // issue 276: priama adresa NÁŠHO produktu z feedu pre porovnávače (issue
  // 220), `null` keď kód vo feede nie je — appka vtedy ukáže kód ako
  // neaktívny text, nikdy vyhľadávací fallback (rovnaký zámer ako
  // `nedostupne/queries.ts`'s `ourProductUrl`, issue 238). `.regex` je druhá
  // vrstva overenia, rovnaký vzor ako `adminUrl`/`supplierUrl` vyššie.
  ourUrl: z.string().regex(/^https?:\/\//).nullable(),
  quantity: z.number(),
  // issue 476/493: piaty stav `riesit` a šiesty `objednane_stav` (label
  // „Objednané", oba exkluzívne, princíp `nedostupne`) — RUČNE zrkadlí
  // `orderLineState.enumValues` z `apps/api/src/db/schema-orders.ts` (nie je
  // odvodené, treba sync na oboch stranách). Bez novej hodnoty by frontend
  // odmietol (zod parse) KAŽDÝ riadok v tom stave a `OrderLine["state"]` typ
  // by ju nepoznal (padne `STATE_LABELS`/`STATE_DISPLAY_ORDER` úplnosť).
  state: z.enum(["objednane", "caka_sa", "skladom", "nedostupne", "riesit", "objednane_stav"]),
  // issue 60: nezávislý príznak "objednané u dodávateľa" (viď `state.ts`'s
  // komentár) — oddelené od `state` vyššie.
  ordered: z.boolean(),
  // issue 67: odkaz na tovar u dodávateľa (`supplierUrl`, `null` keď v
  // exporte nie je odkaz) + surový text pre plain-text fallback
  // (`supplierNote`) + kód tovaru u dodávateľa (`externalCode`).
  // issue 70: `href` bezpečnosť by nemala závisieť LEN od backendovho
  // `extractSupplierLink` regexu — schéma tu overuje http(s) schému
  // nezávisle, ako druhá vrstva.
  supplierUrl: z.string().regex(/^https?:\/\//).nullable(),
  supplierNote: z.string().nullable(),
  externalCode: z.string().nullable(),
  // issue 63: `true`, keď `product.supplier` je v katalógu `null` — presne
  // tie riadky appka nechá manažéra ručne priradiť dodávateľovi.
  // `manualSupplierOverride` je aktuálne uložené priradenie, `null` keď
  // zatiaľ žiadne nie je.
  supplierAssignable: z.boolean(),
  manualSupplierOverride: z.string().nullable(),
  // issue 431: počet OTVORENÝCH objednávok toho istého zákazníka (`apps/api`'s
  // `customerOpenOrderCount`). Odznak pri mene sa ukáže len keď ≥ 2.
  customerOpenOrderCount: z.number(),
});

// issue 63: zrkadlí `queries.ts`'s `NEZNAMY_DODAVATEL` — musí byť IDENTICKÝ
// reťazec, aby autocomplete (`OrdersSection.tsx`) vedel vylúčiť zástupnú
// skupinu zo zoznamu známych dodávateľov.
export const NEZNAMY_DODAVATEL = "(bez dodávateľa)";

// Zrkadlí `OrdersIngestResult` z `apps/api/src/modules/orders/ingest.ts` —
// rovnaký vzor ako katalógov `ingestOutcomeSchema` (`catalogApi.ts`). Na
// rozdiel od katalógu tu nie je "duplicate" verdikt (objednávky sa
// neidentifikujú cez sha256 obsahu exportu) — len "accepted"/"rejected".
const ordersIngestOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    orderCount: z.number(),
    lineCount: z.number(),
    skippedItemCount: z.number(),
    pseudoItemCount: z.number(),
    issueCount: z.number(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: z.string(),
  }),
  // Súbežný import už beží (`ingestInFlight` guard v `orders-routes.ts`) —
  // rovnaký tvar ako katalógov "busy", server ho vracia priamo, bez `rawPath`.
  z.object({
    status: z.literal("busy"),
  }),
]);

export type OrdersIngestOutcome = z.infer<typeof ordersIngestOutcomeSchema>;

// issue 480: predajňový (floor) riadok — produkt pripnutý na nevybavenom zápise
// „Objednávky predajňa", zaradený pod svojho dodávateľa. Zrkadlí `FloorOrderRow`
// z `apps/api/src/modules/orders/queries.ts`. NEMÁ stav ani order/admin odkaz —
// klik vedie na `?tab=floor-orders`; jediná „vybavené" sémantika je `ordered`.
const floorRowSchema = z.object({
  noteId: z.string(),
  variantCode: z.string(),
  productName: z.string(),
  sizeLabel: z.string().nullable(),
  customerName: z.string(),
  quantity: z.number(),
  createdAt: z.string(),
  ordered: z.boolean(),
});
export type FloorOrderRow = z.infer<typeof floorRowSchema>;

const supplierGroupSchema = z.object({
  supplier: z.string(),
  lines: z.array(orderLineSchema),
  // issue 480: predajňové riadky pod tým istým dodávateľom. `.optional()`
  // (nie `.default`) ZÁMERNE — server ich VŽDY posiela (board „Na objednanie"
  // naplnené, sekcia „Riešiť" prázdne `[]`), ale desiatky existujúcich unit
  // testov konštruujú skupinu ako `{ supplier, lines, email }` bez tohto poľa;
  // optional typ ich necháva kompilovať a konzumenti čítajú `floorRows ?? []`.
  floorRows: z.array(floorRowSchema).optional(),
  // E-mailový kontakt dodávateľa (#31), `null` keď zatiaľ nenastavený.
  email: z.string().nullable(),
});

const openOrdersSchema = z.object({ suppliers: z.array(supplierGroupSchema) });

export type OrderLine = z.infer<typeof orderLineSchema>;
export type SupplierOpenOrders = z.infer<typeof supplierGroupSchema>;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako `CatalogUnauthorizedError`. */
export class OrdersUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

const errorBodySchema = z.object({ error: z.string() });

// Rovnaký vzor ako `catalogApi.ts`'s `serverErrorMessage` — server posiela
// `{error: "..."}` telo so slovenskou hláškou (napr. neznámy riadok, neplatný
// stav), ktorú treba zobraziť namiesto všeobecného fallbacku.
async function serverErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // Telo nie je platný JSON (alebo chýba) — použi všeobecnú hlášku.
  }
  return fallback;
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new OrdersUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

// #57: ručné tlačidlo "stiahnuť teraz" na obrazovke Sync zo Shoptetu — volá
// EXISTUJÚCI `POST /api/orders/ingest` (F3, #23), doteraz z webu vôbec
// nedosiahnuteľný (žiadny frontendový wrapper naň neexistoval).
export async function triggerOrdersIngest(): Promise<OrdersIngestOutcome> {
  const response = await fetch("/api/orders/ingest", { method: "POST" });
  return ordersIngestOutcomeSchema.parse(await readJson(response, "Import objednávok sa nepodarilo spustiť"));
}

// issue 59: nastavenie, ktoré Shoptet stavy sa počítajú ako "objednávka sa
// ešte vybavuje" (rozhoduje o obsahu `fetchOpenOrders` vyššie).
const openStatusesConfigSchema = z.object({
  statuses: z.array(z.string()),
  // Distinct hodnoty `status_name`, aké appka skutočne videla v exportoch —
  // pomôcka pri editácii (over preklep), nikdy sa neposiela naspäť pri uložení.
  knownStatuses: z.array(z.string()),
});

export type OpenStatusesConfig = z.infer<typeof openStatusesConfigSchema>;

export async function fetchOpenStatusesConfig(): Promise<OpenStatusesConfig> {
  const response = await fetch("/api/orders/open-statuses");
  return openStatusesConfigSchema.parse(await readJson(response, "Nastavenie otvorených stavov sa nepodarilo načítať"));
}

const saveOpenStatusesResultSchema = z.object({ ok: z.literal(true), statuses: z.array(z.string()) });

export async function saveOpenStatuses(statuses: readonly string[]): Promise<readonly string[]> {
  const response = await fetch("/api/orders/open-statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses }),
  });
  const telo = saveOpenStatusesResultSchema.parse(
    await readJson(response, "Nastavenie otvorených stavov sa nepodarilo uložiť"),
  );
  return telo.statuses;
}

export async function fetchOpenOrders(): Promise<readonly SupplierOpenOrders[]> {
  const response = await fetch("/api/orders/open");
  const parsed = openOrdersSchema.parse(
    await readJson(response, "Otvorené objednávky sa nepodarilo načítať"),
  );
  return parsed.suppliers;
}

// issue 476: sekcia „Riešiť" — tie isté zoskupené riadky ako `fetchOpenOrders`,
// len zúžené na stav `riesit` (server-strana `stateFilter`). Rovnaká schéma
// odpovede.
export async function fetchRiesitOrders(): Promise<readonly SupplierOpenOrders[]> {
  const response = await fetch("/api/orders/riesit");
  const parsed = openOrdersSchema.parse(
    await readJson(response, "Objednávky na riešenie sa nepodarilo načítať"),
  );
  return parsed.suppliers;
}

const riesitCountSchema = z.object({ count: z.number() });

// issue 476: počet pre menu odznak „Riešiť" — vzor issue 473 (App.tsx fetch +
// badge context). Chybu zachytáva volajúci `App.tsx` (vždy vráti 0 pri
// zlyhaní), rovnako ako `fetchUnresolvedFloorNotesCount`.
export async function fetchRiesitCount(): Promise<number> {
  try {
    const response = await fetch("/api/orders/riesit/count");
    if (!response.ok) return 0;
    return riesitCountSchema.parse(await response.json()).count;
  } catch {
    return 0;
  }
}

// issue 476: server vracia 200 v OBOCH prípadoch — úspech `{ok:true,lineCount}`
// aj OČAKÁVANÝ používateľský omyl (neznáme/zatvorené číslo) `{ok:false,error}`
// — NIKDY 4xx za taký omyl (Chromium by zalogoval konzolovú chybu, viď server
// komentár + `.claude/rules/testing.md`; rovnaký vzor ako `sendSupplierOrderMail`).
const riesitByCodeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), lineCount: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

// issue 476: rýchle pole „číslo objednávky → Enter" — nastaví stav `riesit` na
// všetkých riadkoch danej objednávky. Doménový neúspech (neznáme/zatvorené
// číslo) príde ako 200 `{ok:false,error}` — vyhodíme `Error(error)`, aby ju
// `RiesitSection` zobrazila cez existujúci `catch`; 4xx/5xx (401, CSRF, ...) sú
// SKUTOČNÉ HTTP chyby a rieši ich `readJson`.
export async function setOrderLinesRiesitByCode(code: string): Promise<{ readonly lineCount: number }> {
  const response = await fetch("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const telo = riesitByCodeResultSchema.parse(await readJson(response, "Označenie objednávky sa nepodarilo"));
  if (!telo.ok) throw new Error(telo.error);
  return { lineCount: telo.lineCount };
}

// issue 237: "Prehľad e-shopu" (dnes/tento týždeň/tento mesiac) — zrkadlí
// `apps/api/src/modules/orders/overview.ts`'s `OrdersDashboardOverview`.
// `revenue` je `numeric`-reťazec (`"1234.56"`, presne dve desatinné miesta) —
// zobrazuje sa priamo, rovnaký vzor ako `SupplierStockSection.tsx`'s
// `${row.price} €`.
const periodStatsSchema = z.object({ orderCount: z.number(), revenue: z.string() });

const ordersOverviewSchema = z.object({
  today: periodStatsSchema,
  week: periodStatsSchema,
  month: periodStatsSchema,
});

export type OrdersPeriodStats = z.infer<typeof periodStatsSchema>;
export type OrdersOverview = z.infer<typeof ordersOverviewSchema>;

export async function fetchOrdersOverview(): Promise<OrdersOverview> {
  const response = await fetch("/api/orders/overview");
  return ordersOverviewSchema.parse(await readJson(response, "Prehľad e-shopu sa nepodarilo načítať"));
}

// #25: zmena stavu riadku objednávky — `lineId` je globálne unikátne (UUID
// primárny kľúč `order_line.id`), netreba aj `orderId`.
export async function updateOrderLineState(
  lineId: string,
  state: OrderLine["state"],
): Promise<void> {
  const response = await fetch(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  await readJson(response, "Zmena stavu sa nepodarila");
}

// issue 60: odškrtávacie políčko "objednané u dodávateľa" — NEZÁVISLÉ od
// `updateOrderLineState` vyššie.
export async function updateOrderLineOrdered(lineId: string, ordered: boolean): Promise<void> {
  const response = await fetch(`/api/orders/lines/${lineId}/ordered`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ordered }),
  });
  await readJson(response, "Zmena príznaku objednané sa nepodarila");
}

// issue 63: ručné priradenie dodávateľa riadku, ktorého `product.supplier` je
// `null`. Platí pre celý PRODUKT (server-strana `assignOrderLineSupplier`),
// nie len tento jeden riadok — volajúci (`OrdersSection.tsx`) preto po
// úspechu robí PLNÝ refetch (`fetchOpenOrders`), nie lokálnu opravu stavu:
// riadok mení SKUPINU, rovnaký dôvod ako `PairingSection.tsx` po potvrdení.
export async function assignOrderLineSupplier(lineId: string, supplier: string): Promise<void> {
  const response = await fetch(`/api/orders/lines/${lineId}/supplier`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ supplier }),
  });
  await readJson(response, "Priradenie dodávateľa sa nepodarilo");
}

// issue 153: zrkadlí `orderLineSupplierLinkBody` (`apps/api/src/http/
// orders-routes.ts`) DO ZNAKU — trim, tvar URL, dĺžkový strop, http(s)
// schéma. NEODVODZUJE sa od žiadnej existujúcej schémy vyššie (tie parsujú
// ODPOVEĎ zo servera; táto validuje VSTUP PRED odoslaním) — rovnaký duálny
// vzor ako `adminUrl`/`supplierUrl` (issue 70), zámerne nezdieľaný typový
// balík (žiadny medzi web/api zatiaľ neexistuje, viď modulový komentár
// vyššie). Formula-guard (CSV-injection ochrana) sa tu ZÁMERNE neopakuje —
// je to server-side/CSV-sink kontrola (issue 153's design komentár), nie
// niečo, čo by zamestnanec pri písaní odkazu mal vidieť ako "chybu vstupu".
const supplierLinkUrlInput = z.string().trim().max(2000).url().regex(/^https?:\/\//);

/** `null`, keď je `url` (po orezaní) platná — inak zrozumiteľná slovenská
 * hláška na OKAMŽITÉ odmietnutie V PREHLIADAČI, bez čakania na round-trip
 * na server (issue 153 — predtým appka kontrolovala len neprázdnosť). */
export function validateSupplierLinkUrl(url: string): string | null {
  return supplierLinkUrlInput.safeParse(url).success
    ? null
    : "Odkaz musí byť platná adresa začínajúca http:// alebo https://.";
}

// issue 121: manuálny odkaz na dodávateľa — NA ROZDIEL od priradenia
// dodávateľa vyššie sa smie upraviť pri KAŽDOM produkte, aj keď už jeden
// odkaz (zo Shoptetu) má. Rovnaký dôvod na PLNÝ refetch po úspechu ako
// `assignOrderLineSupplier` — zmena platí pre celý PRODUKT (server-strana
// `setProductSupplierLink`), teda aj pre súrodenecké veľkosti toho istého
// riadku, nielen preň samotný.
export async function setProductSupplierLink(lineId: string, url: string): Promise<void> {
  const response = await fetch(`/api/orders/lines/${lineId}/supplier-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  await readJson(response, "Uloženie odkazu na dodávateľa sa nepodarilo");
}

// issue 64: manažérova voľná poznámka k CELEJ objednávke — `orderId` je
// spoločný pre VŠETKY riadky tej istej objednávky (`OrderLine.orderId`),
// server-strana `setOrderComment` (`modules/orders/state.ts`) mutuje
// `order.comment` priamo, nezávisle od `lineId`. Prázdny reťazec (po orezaní
// na serveri) maže poznámku — volajúci (`OrdersSection.tsx`'s `changeComment`)
// posiela `comment ?? ""` rovnakým vzorom ako `setSupplierEmail`.
export async function updateOrderComment(orderId: string, comment: string | null): Promise<void> {
  const response = await fetch(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ comment: comment ?? "" }),
  });
  await readJson(response, "Uloženie poznámky sa nepodarilo");
}

const setSupplierLinesOrderedResultSchema = z.object({ ok: z.literal(true), ordered: z.boolean(), lineCount: z.number() });

// issue 60: hromadné označenie/zrušenie CELEJ skupiny dodávateľa naraz — server
// sám nájde presne tie riadky, ktoré `fetchOpenOrders` pre daného dodávateľa
// PRÁVE TERAZ zobrazuje (`modules/orders/state.ts`'s `setSupplierLinesOrdered`).
export async function setSupplierLinesOrdered(
  supplier: string,
  ordered: boolean,
): Promise<{ readonly lineCount: number }> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/order-lines/ordered`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ordered }),
  });
  const telo = setSupplierLinesOrderedResultSchema.parse(
    await readJson(response, "Hromadné označenie skupiny sa nepodarilo"),
  );
  return { lineCount: telo.lineCount };
}

// issue 480: „objednané" na predajňovom riadku v board-e „Na objednanie" —
// volá `POST /api/floor-notes/:id/products/:variantCode/ordered`. Server
// prepočíta note-level 🛒. 401 hádže `OrdersUnauthorizedError` (cez `readJson`),
// aby to `useOrderLinesBoard` spracoval rovnako ako ostatné board mutácie.
export async function setFloorRowOrdered(noteId: string, variantCode: string, ordered: boolean): Promise<void> {
  const response = await fetch(
    `/api/floor-notes/${encodeURIComponent(noteId)}/products/${encodeURIComponent(variantCode)}/ordered`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: ordered }),
    },
  );
  await readJson(response, "Zmena príznaku objednané sa nepodarila");
}

// #31: e-mailový kontakt dodávateľa + odoslanie objednávky mailom.
export async function setSupplierEmail(supplier: string, email: string | null): Promise<void> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/email`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email ?? "" }),
  });
  await readJson(response, "Nastavenie e-mailu sa nepodarilo");
}

const orderMailPreviewSchema = z.object({
  supplier: z.string(),
  to: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  itemCount: z.number(),
});

export type OrderMailPreview = z.infer<typeof orderMailPreviewSchema>;

export async function fetchSupplierOrderMailPreview(supplier: string): Promise<OrderMailPreview> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/order-mail`);
  return orderMailPreviewSchema.parse(await readJson(response, "Náhľad mailu sa nepodarilo načítať"));
}

const sendOrderMailResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

/**
 * Odoslanie prebehlo — `ok` hovorí, či mail reálne odišiel. Na rozdiel od
 * `readJson` NEhádže na 502/503 (nenakonfigurovaný mailer/zlyhané SMTP) —
 * tie sú tu rovnocenné "no_email"/"no_items" doménovým výsledkom (odlišné len
 * HTTP kódom, `http/supplier-routes.ts`), UI ich zobrazuje rovnako ako chybu
 * poslania, nie ako neočakávanú výnimku.
 */
export async function sendSupplierOrderMail(supplier: string): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/order-mail/send`, {
    method: "POST",
  });
  if (response.status === 401) throw new OrdersUnauthorizedError();
  if (!response.ok) {
    return { ok: false, error: await serverErrorMessage(response, "Odoslanie objednávky mailom sa nepodarilo") };
  }
  const telo = sendOrderMailResultSchema.parse(await response.json());
  return { ok: telo.ok, ...(telo.error === undefined ? {} : { error: telo.error }) };
}
