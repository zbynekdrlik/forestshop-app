import { and, asc, countDistinct, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  floorNoteProducts,
  floorNotes,
  orderLines,
  orders,
  productSupplierLinkOverrides,
  productSupplierOverrides,
  products,
  shopProductUrl,
  supplierContacts,
  variants,
  type OrderLineState,
} from "../../db/schema.js";
import { extractForeignShopRemark } from "../shoptet-writeback/note-block.js";
import { customerIdentityKey } from "./customer-identity.js";
import { resolveEffectiveSupplierLink } from "./effective-supplier-link.js";
import { listOpenStatusNames } from "./open-statuses.js";
import { effectiveSupplierSql, normalizedSupplierKeySql, normalizeSupplierKeyJs, pickCanonicalSupplierSpelling } from "./supplier-key.js";

// issue 120: keď appka POZNÁ interné Shoptet id objednávky (`order.shoptet_
// order_id`, naplnené SAMOSTATNÝM XML exportom — `modules/orders/ingest.ts`
// + `parser.ts`'s `extractOrderIdsFromXml`), odkaz ide PRIAMO na detail
// objednávky (presne to, čo majiteľ žiadal, #120) — naživo overené (dev2,
// 2026-07-31), že `/admin/objednavky-detail/?id=<interné id>` je jediný
// tvar, čo Shoptet admin na tejto trase akceptuje.
//
// issue 65: keď id (zatiaľ) NEZNÁME (premenná nenastavená, XML fetch
// zlyhal, alebo objednávka je staršia než okno, ktoré appka doteraz
// stihla obohatiť), odkaz PADÁ SPÄŤ na globálne vyhľadávanie podľa KÓDU
// objednávky — jediný funkčný GET deep-link BEZ interného id (naživo
// overené 2026-07-22, sesterský projekt `parovanie_produktov`'s
// `posta_uncollected.py`/`orders_reminder.py`). `?code=`/`?query=` priamo
// na `objednavky-detail/` (staršie, nefunkčné zistenie) appka NEPOUŽÍVA —
// admin ho ticho ignoruje. `adminBaseUrl` je `env.ts`'s
// `SHOPTET_ADMIN_BASE_URL` — nikdy natvrdo v kóde.
export function buildShoptetAdminOrderUrl(
  adminBaseUrl: string,
  externalOrderId: string,
  shoptetOrderId: number | null,
): string {
  if (shoptetOrderId !== null) {
    return `${adminBaseUrl}/admin/objednavky-detail/?id=${encodeURIComponent(String(shoptetOrderId))}`;
  }
  return `${adminBaseUrl}/admin/vyhladavanie/?string=${encodeURIComponent(externalOrderId)}&src=orders`;
}

export interface OpenOrderLine {
  readonly lineId: string;
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly comment: string | null;
  // issue 65: zákaznícky odkaz k objednávke (Shoptet export's `remark`
  // stĺpec — NIE `shopRemark`, interná poznámka predajne, `.claude/rules/
  // orders.md`). Read-only na obrazovke, nikdy sa needituje z appky.
  readonly remark: string | null;
  // issue 164: INTERNÁ poznámka e-shopu — na rozdiel od DB stĺpca
  // (`order.shop_remark`, SUROVÁ, môže niesť aj náš vlastný blok) je toto UŽ
  // ODVODENÁ hodnota (`extractForeignShopRemark` nižšie) — LEN cudzí (nie-
  // appkin) text, nikdy náš vlastný zapísaný blok. Read-only, appka ju nikdy
  // needituje (rovnaký zámer ako `remark` vyššie) — appkina VLASTNÁ poznámka
  // je nezávislé pole `comment`.
  readonly shopRemark: string | null;
  // issue 65: priamy odkaz do Shoptet administrácie na TÚTO objednávku
  // (`buildShoptetAdminOrderUrl` vyššie).
  readonly adminUrl: string;
  readonly placedAt: string;
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  /**
   * issue 276: priama adresa NÁŠHO produktu z feedu pre porovnávače (issue
   * 220, `shop_product_url`), `null` keď kód vo feede nie je. Rovnaký zámer
   * ako `nedostupne/queries.ts`'s `ourProductUrl` (issue 238) — majiteľova
   * podmienka je identická: KEĎ adresu nemáme, kód sa ukáže ako neaktívny
   * text, NIKDY vyhľadávací fallback (`shopLinks.ts`'s `ourProductLink`
   * používa `restock`/e2e obrazovka, tu zámerne nie).
   */
  readonly ourUrl: string | null;
  readonly quantity: number;
  readonly state: OrderLineState;
  // issue 60: nezávislý príznak "objednané u dodávateľa" (viď komentár k
  // `orderLines.ordered` v `schema-orders.ts`) — oddelené od `state` vyššie.
  readonly ordered: boolean;
  // issue 67: odkaz na tovar u dodávateľa (extrahovaný z `product.internalNote`
  // cez `extractSupplierLink`) a kód tovaru u dodávateľa (`variant.externalCode`,
  // priamo). `supplierUrl` je `null`, keď v `internalNote` nie je odkaz —
  // vtedy `supplierNote` (surový pôvodný text, ak nejaký je) slúži ako
  // plain-text fallback na obrazovke.
  readonly supplierUrl: string | null;
  readonly supplierNote: string | null;
  readonly externalCode: string | null;
  // issue 63: `true`, keď `product.supplier` je `null` — presne tie riadky,
  // ktoré appka smie nechať manažéra ručne priradiť (`modules/orders/
  // supplier-key.ts`'s `effectiveSupplierSql`). `manualSupplierOverride` je
  // aktuálne uložené priradenie (`product_supplier_override`), `null` keď
  // zatiaľ žiadne nie je — obe polia sa počítajú LEN keď je katalógová
  // hodnota `null` (dormantný override, ktorý katalóg medzitým prebil
  // reálnou hodnotou, sa nezobrazuje, aby manažéra nemiatol falošným "toto
  // som priradil ja").
  readonly supplierAssignable: boolean;
  readonly manualSupplierOverride: string | null;
  // issue 431: počet DISTINCT OTVORENÝCH objednávok TOHO ISTÉHO zákazníka
  // (`customerIdentityKey` — zdieľaná identita so "Zlúčenie objednávok",
  // `merge-mail.ts`). Frontend zobrazí odznak pri mene, len keď ≥ 2 (signál
  // "zváž zlúčenie do jednej zásielky"). "Otvorená" = tá istá definícia ako
  // celý tento dopyt (`order.status_name ∈ order_open_status`), takže
  // Stornovaná/Vybavená sa nerátajú.
  readonly customerOpenOrderCount: number;
}

// issue 480: predajňový (floor) riadok v board-e „Na objednanie" — produkt
// pripnutý na NEVYBAVENOM zápise „Objednávky predajňa" (`floor_note_product`),
// zaradený pod svojho dodávateľa rovnakou efektívnou cestou ako `order_line`
// (viď `listOpenOrderLinesBySupplier` nižšie). NEMÁ stavový automat ani väzbu
// na `order_line` — nesie LEN značku „objednané" (`ordered`, z
// `floor_note_product.ordered_at`). Klik na obrazovke vedie na zápis v
// „Objednávky predajňa" (`?tab=floor-orders`), preto tu nie je žiadny
// admin/Shoptet odkaz. Do e-mailu dodávateľovi sa NEZAHŔŇA (`mail.ts` číta len
// `order_line`).
export interface FloorOrderRow {
  // `floor_note_product` je kľúčované dvojicou (noteId, variantCode) — obe
  // treba na zapisovaciu trasu „objednané" aj ako stabilný React key.
  readonly noteId: string;
  readonly variantCode: string;
  readonly productName: string;
  readonly sizeLabel: string | null;
  // Meno zákazníka = PRVÝ riadok voľného textu zápisu, orezaný (zadanie
  // klienta). Prázdny reťazec, keď je text prázdny (v praxi nenastane —
  // `createBody`'s `.min(1)`).
  readonly customerName: string;
  readonly quantity: number;
  // `floor_note.created_at` (dátum zápisu) — ISO 8601 reťazec, rovnaký tvar
  // ako `OpenOrderLine.placedAt`, aby triedenie skupín fungovalo jednotne.
  readonly createdAt: string;
  // `floor_note_product.ordered_at !== null` — jediná „vybavené" sémantika
  // floor riadku (žiadny stav).
  readonly ordered: boolean;
}

export interface SupplierOpenOrders {
  readonly supplier: string;
  readonly lines: readonly OpenOrderLine[];
  // issue 480: predajňové riadky pod tým istým dodávateľom (vždy prítomné pole,
  // prázdne pre sekciu „Riešiť" — tá `stateFilter` nastavuje, floor riadky sa
  // pridávajú LEN keď `stateFilter === undefined`).
  readonly floorRows: readonly FloorOrderRow[];
  // E-mailový kontakt dodávateľa (#31), `null` keď zatiaľ nenastavený —
  // `supplier_contact` je samostatná tabuľka (manažér ju edituje nezávisle
  // od importu objednávok), preto sa dopytuje osobitne od hlavného
  // zoskupovacieho dopytu nižšie, nie cez JOIN naň (zástupný kľúč
  // "(bez dodávateľa)" nemá zodpovedajúci `product.supplier`, na ktorý by sa
  // dalo joinovať — kontakt sa priraďuje AŽ PO zoskupení, podľa rovnakého
  // zobrazovaného kľúča).
  readonly email: string | null;
}

// `product.supplier` je v schéme nepovinné (`text("supplier")`, bez
// `.notNull()`) — Shoptet export niekedy nesie prázdnu hodnotu (`map-row.ts`'s
// `textOrNull`). Zoskupenie takých riadkov dostáva čitateľný zástupný kľúč
// namiesto toho, aby zmizli/spadli na `null` kľúč v Mape.
// Exportované (nie len modulová konštanta) — `modules/orders/mail.ts` (#31)
// potrebuje TEN ISTÝ reťazec pri hľadaní kontaktu/agregovaní outstanding
// riadkov pre zástupnú skupinu, nikdy vlastnú duplicitnú definíciu, ktorá by
// sa mohla rozísť.
export const NEZNAMY_DODAVATEL = "(bez dodávateľa)";

// Zoskupenie je na ÚROVNI RIADKA objednávky, nie na úrovni objednávky —
// jedna objednávka môže obsahovať položky od VIACERÝCH dodávateľov
// (`docs/stara-appka-inventar.md` bod 1: "Otvorené objednávky zoskupené
// podľa dodávateľa"). `order_line.state` (objednane/caka_sa/skladom/
// nedostupne) je appkou/manažérom riadený automat NEZÁVISLÝ od tohto
// filtra — "otvorená" tu (issue 59) znamená, že SAMOTNÁ OBJEDNÁVKA má v
// Shoptete jeden z nastavených stavov (`order.status_name`,
// `open-statuses.ts`), rovnaký zámer ako stará appka's `to_order`. Bez
// nastaveného stavu (čo `replaceOpenStatusNames` nedovolí) by dopyt nemal
// podľa čoho filtrovať — vtedy sa vráti prázdny zoznam namiesto behu
// `inArray` s prázdnym poľom.
// issue 431: počet OTVORENÝCH objednávok na zákazníka — kľúčované zdieľaným
// `customerIdentityKey` (email → inak meno), TÁ ISTÁ identita ako "Zlúčenie
// objednávok" (`merge-mail.ts`). Počíta sa nad SAMOTNOU tabuľkou `order`
// (jeden riadok = jedna objednávka), nie nad riadkami objednávok, takže je to
// autoritatívny počet DISTINCT objednávok, nezávislý od toho, koľko riadkov
// sa práve zobrazuje. `openStatuses` sa odovzdáva (volajúci ho už má), aby sa
// zoznam otvorených stavov nečítal z DB dvakrát v jednom dopyte "Na objednanie".
export async function countOpenOrdersByCustomer(
  db: Pick<Database, "select">,
  openStatuses: readonly string[],
): Promise<Map<string, number>> {
  if (openStatuses.length === 0) return new Map();
  const rows = await db
    .select({ customerName: orders.customerName, email: orders.email })
    .from(orders)
    .where(inArray(orders.statusName, [...openStatuses]));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = customerIdentityKey(row.email, row.customerName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// issue 480: predajňové riadky pre board „Na objednanie" — produkty pripnuté na
// NEVYBAVENÝCH zápisoch (`floor_note.resolved = false`) s efektívnym
// dodávateľom počítaným TOU ISTOU cestou ako `order_line`
// (`effectiveSupplierSql = coalesce(products.supplier, override)`,
// `supplier-key.ts`). Zámerne SAMOSTATNÝ dopyt (nie JOIN na hlavný riadkový),
// keďže floor riadky sa zoskupujú per dodávateľ AŽ v JS spolu s riadkami
// objednávok. Zoradené najnovšie-prvé (zhodne s hlavným dopytom), aby
// `floorRows[0]` bol najnovší floor riadok skupiny (triedenie skupín nižšie).
// Vracia `effectiveSupplier` ako surový reťazec (`null` = bez dodávateľa) —
// normalizáciu/kanonický pravopis rieši volajúci rovnako ako pri order_line.
async function listUnresolvedFloorOrderRows(
  db: Pick<Database, "select">,
): Promise<readonly (FloorOrderRow & { readonly effectiveSupplier: string | null })[]> {
  const rows = await db
    .select({
      noteId: floorNoteProducts.floorNoteId,
      noteText: floorNotes.text,
      noteCreatedAt: floorNotes.createdAt,
      variantCode: floorNoteProducts.variantCode,
      productName: variants.name,
      sizeLabel: variants.sizeLabel,
      quantity: floorNoteProducts.quantity,
      orderedAt: floorNoteProducts.orderedAt,
      effectiveSupplier: effectiveSupplierSql,
    })
    .from(floorNoteProducts)
    .innerJoin(floorNotes, eq(floorNotes.id, floorNoteProducts.floorNoteId))
    .innerJoin(variants, eq(variants.code, floorNoteProducts.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(productSupplierOverrides, eq(productSupplierOverrides.productKey, products.key))
    .where(eq(floorNotes.resolved, false))
    .orderBy(desc(floorNotes.createdAt), desc(floorNoteProducts.id));

  return rows.map((row) => ({
    noteId: row.noteId,
    variantCode: row.variantCode,
    productName: row.productName,
    sizeLabel: row.sizeLabel,
    // Meno zákazníka = prvý riadok textu zápisu, orezaný (zadanie klienta).
    customerName: (row.noteText.split(/\r?\n/)[0] ?? "").trim(),
    quantity: row.quantity,
    createdAt: row.noteCreatedAt.toISOString(),
    ordered: row.orderedAt !== null,
    effectiveSupplier: row.effectiveSupplier,
  }));
}

export async function listOpenOrderLinesBySupplier(
  db: Database,
  adminBaseUrl: string,
  // issue 476: voliteľný filter na jeden stav riadku — sekcia „Riešiť" volá
  // s `stateFilter: "riesit"`, aby dostala PRESNE tie isté zoskupené riadky
  // ako Na objednanie, len zúžené na stav `riesit` (NEduplikuje sa query
  // logika, len sa pridá jedna WHERE podmienka). Bez neho (Na objednanie)
  // ostáva správanie 1:1 nezmenené.
  opts?: { readonly stateFilter?: OrderLineState },
): Promise<readonly SupplierOpenOrders[]> {
  const openStatuses = await listOpenStatusNames(db);
  const stateFilter = opts?.stateFilter;
  // issue 480: sekcia „Riešiť" (stateFilter) potrebuje nastavené otvorené stavy
  // — bez nich niet čo filtrovať, vráť prázdno (nezmenené správanie). „Na
  // objednanie" (stateFilter undefined) môže mať PREDAJŇOVÉ riadky aj bez
  // otvorených objednávok/stavov, takže sa NEsmie predčasne vrátiť — order-line
  // dopyt sa len preskočí (prázdne `rows`), floor riadky sa pridajú nižšie.
  if (openStatuses.length === 0 && stateFilter !== undefined) return [];

  // issue 431: počet otvorených objednávok na zákazníka, spočítaný RAZ pre
  // celý zoznam (nie per riadok) — priloží sa ku každému riadku nižšie podľa
  // jeho `customerIdentityKey`. Prázdna mapa, keď nie sú nastavené otvorené
  // stavy (order-line dopyt sa aj tak preskočí).
  const openOrderCountByCustomer =
    openStatuses.length > 0 ? await countOpenOrdersByCustomer(db, openStatuses) : new Map<string, number>();

  // issue 480: `inArray(..., [])` je nekorektné (viď komentár pri
  // `countOpenOrdersByCustomer`), preto sa order-line dopyt pri prázdnych
  // otvorených stavoch VÔBEC nespustí — `rows` je prázdne a nižší cyklus
  // jednoducho nič nepridá (predajňové riadky sa pridajú samostatne).
  const rows =
    openStatuses.length === 0
      ? []
      : await db
    .select({
      lineId: orderLines.id,
      orderId: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      email: orders.email,
      comment: orders.comment,
      remark: orders.remark,
      shopRemarkRaw: orders.shopRemark,
      shoptetOrderId: orders.shoptetOrderId,
      placedAt: orders.placedAt,
      variantCode: orderLines.variantCode,
      variantName: variants.name,
      sizeLabel: variants.sizeLabel,
      quantity: orderLines.quantity,
      state: orderLines.state,
      ordered: orderLines.ordered,
      catalogSupplier: products.supplier,
      effectiveSupplier: effectiveSupplierSql,
      overrideSupplier: productSupplierOverrides.supplier,
      internalNote: products.internalNote,
      supplierLinkOverride: productSupplierLinkOverrides.url,
      externalCode: variants.externalCode,
      ourUrl: shopProductUrl.url,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(productSupplierOverrides, eq(productSupplierOverrides.productKey, products.key))
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key))
    // issue 276: LEFT zámerne — variant bez záznamu vo feede NESMIE zo
    // zoznamu vypadnúť (rovnaký dôvod ako `restock/queries.ts`/
    // `nedostupne/queries.ts`), len jeho kód sa vykreslí ako neaktívny text.
    .leftJoin(shopProductUrl, eq(shopProductUrl.code, orderLines.variantCode))
    .where(
      // issue 476: `stateFilter` (sekcia Riešiť) pridá `state = 'riesit'`; bez
      // neho (Na objednanie) len otvorené Shoptet stavy, ako doteraz.
      stateFilter === undefined
        ? inArray(orders.statusName, [...openStatuses])
        : and(inArray(orders.statusName, [...openStatuses]), eq(orderLines.state, stateFilter)),
    )
    // Sekundárne triedenie podľa najnovšej objednávky ako prvej v rámci
    // dodávateľa — rovnaký zámer ako katalógov `desc(fetchedAt), desc(id)`
    // tie-break, len tu na `placedAt`/`lineId`, aby poradie riadkov v rámci
    // JEDNEJ skupiny bolo stabilné aj pri zhodnom čase. Poradie SKUPÍN sa
    // teraz počíta AŽ po zoskupení nižšie (issue 63) — `effectiveSupplier`
    // (override-aware, case/whitespace-normalizovaný) už nie je jednoduchý
    // stĺpec, ktorý by SQL `ORDER BY` mohol zoradiť zmysluplne samo osebe.
    .orderBy(desc(orders.placedAt), desc(orderLines.id));

  // issue 63: zoskupenie podľa NORMALIZOVANÉHO kľúča (case/whitespace-
  // insensitive, `normalizeSupplierKeyJs`) — dva pravopisy toho istého
  // dodávateľa (buď z katalógu, alebo z ručného priradenia) padnú do JEDNEJ
  // skupiny. `spellingCounts` drží počet riadkov na KAŽDÝ videný pravopis,
  // aby sa dala zvoliť zobrazovaná forma (`pickCanonicalSupplierSpelling`).
  const NULL_GROUP_KEY = " none";
  interface GroupAccumulator {
    readonly lines: OpenOrderLine[];
    // issue 480: predajňové riadky tej istej dodávateľskej skupiny.
    readonly floorRows: FloorOrderRow[];
    readonly spellingCounts: Map<string, number>;
  }
  const bySupplier = new Map<string, GroupAccumulator>();
  for (const row of rows) {
    const supplierLink = resolveEffectiveSupplierLink(row.internalNote, row.supplierLinkOverride);
    const catalogSupplierIsNull = row.catalogSupplier === null;
    const line: OpenOrderLine = {
      lineId: row.lineId,
      orderId: row.orderId,
      externalOrderId: row.externalOrderId,
      customerName: row.customerName,
      comment: row.comment,
      remark: row.remark,
      shopRemark: extractForeignShopRemark(row.shopRemarkRaw),
      adminUrl: buildShoptetAdminOrderUrl(adminBaseUrl, row.externalOrderId, row.shoptetOrderId),
      placedAt: row.placedAt.toISOString(),
      variantCode: row.variantCode,
      variantName: row.variantName,
      sizeLabel: row.sizeLabel,
      ourUrl: row.ourUrl,
      quantity: row.quantity,
      state: row.state,
      ordered: row.ordered,
      supplierUrl: supplierLink.url,
      supplierNote: supplierLink.note,
      externalCode: row.externalCode,
      supplierAssignable: catalogSupplierIsNull,
      manualSupplierOverride: catalogSupplierIsNull ? (row.overrideSupplier ?? null) : null,
      // issue 431: počet otvorených objednávok toho istého zákazníka (0 nikdy
      // nenastane — riadok existuje, teda jeho objednávka je otvorená, takže
      // count je aspoň 1; `?? 0` je len defenzívny fallback).
      customerOpenOrderCount: openOrderCountByCustomer.get(customerIdentityKey(row.email, row.customerName)) ?? 0,
    };
    const groupKey = row.effectiveSupplier === null ? NULL_GROUP_KEY : normalizeSupplierKeyJs(row.effectiveSupplier);
    let acc = bySupplier.get(groupKey);
    if (acc === undefined) {
      acc = { lines: [], floorRows: [], spellingCounts: new Map() };
      bySupplier.set(groupKey, acc);
    }
    acc.lines.push(line);
    if (row.effectiveSupplier !== null) {
      acc.spellingCounts.set(row.effectiveSupplier, (acc.spellingCounts.get(row.effectiveSupplier) ?? 0) + 1);
    }
  }

  // issue 480: predajňové (floor) riadky sa pridávajú LEN do „Na objednanie"
  // (`stateFilter === undefined`) — NIKDY do sekcie „Riešiť" (tá filtruje na
  // stav `riesit`, ktorý floor riadky nemajú). Zaraďujú sa do TEJ ISTEJ
  // `bySupplier` mapy rovnakým normalizovaným kľúčom, takže produkt bez
  // otvorenej objednávky vytvorí novú skupinu (aj `NEZNAMY_DODAVATEL`), a
  // prispievajú do `spellingCounts`, aby floor-only skupina mala kanonický
  // pravopis pre `pickCanonicalSupplierSpelling` nižšie.
  if (stateFilter === undefined) {
    const floorRawRows = await listUnresolvedFloorOrderRows(db);
    for (const { effectiveSupplier, ...floorRow } of floorRawRows) {
      const groupKey = effectiveSupplier === null ? NULL_GROUP_KEY : normalizeSupplierKeyJs(effectiveSupplier);
      let acc = bySupplier.get(groupKey);
      if (acc === undefined) {
        acc = { lines: [], floorRows: [], spellingCounts: new Map() };
        bySupplier.set(groupKey, acc);
      }
      acc.floorRows.push(floorRow);
      if (effectiveSupplier !== null) {
        acc.spellingCounts.set(effectiveSupplier, (acc.spellingCounts.get(effectiveSupplier) ?? 0) + 1);
      }
    }
  }

  const contactRows = await db
    .select({ supplier: supplierContacts.supplier, email: supplierContacts.email })
    .from(supplierContacts);
  const emailBySupplier = new Map(contactRows.map((row) => [row.supplier, row.email]));

  const groups = [...bySupplier.entries()].map(([groupKey, acc]) => {
    const supplier = groupKey === NULL_GROUP_KEY ? NEZNAMY_DODAVATEL : pickCanonicalSupplierSpelling(acc.spellingCounts);
    return { supplier, lines: acc.lines, floorRows: acc.floorRows, email: emailBySupplier.get(supplier) ?? null };
  });
  // issue 152: skupiny podľa NAJNOVŠEJ objednávky (najčerstvejšia prvá),
  // pri zhode abecedne — priamy náprotivok starej appky (`app.js:2470-2476`,
  // `2671-2672`). "(bez dodávateľa)" vždy naposledy (rovnaké správanie ako
  // predtým — Postgres `ASC` triedenie `products.supplier` malo default
  // `NULLS LAST`), bez ohľadu na jej vlastnú najnovšiu objednávku.
  // `acc.lines[0]` je zaručene najnovší riadok DANEJ skupiny — riadky vyššie
  // (`.orderBy(desc(orders.placedAt), desc(orderLines.id))`) sú UŽ zoradené
  // najnovšie-prvé PRED zoskupením, takže prvý riadok, aký ktorákoľvek
  // skupina pri iterácii dostane, je vždy jej najnovší (žiadny ďalší dopyt
  // ani prepočet netreba). `placedAt` je už ISO 8601 reťazec, takže
  // reťazcové porovnanie zodpovedá chronologickému poradiu bez parsovania.
  // issue 480: „najnovšie" skupiny je teraz max z najnovšej objednávky
  // (`lines[0].placedAt`) A najnovšieho predajňového zápisu (`floorRows[0]
  // .createdAt`) — obe sú ISO 8601 reťazce (reťazcové porovnanie = chronológia),
  // obe polia sú UŽ zoradené najnovšie-prvé pred zoskupením, takže index [0] je
  // najnovší člen daného druhu. Floor-only skupina (bez objednávok) sa tak
  // zaradí podľa dátumu svojho najnovšieho zápisu.
  const groupNewest = (g: { readonly lines: readonly OpenOrderLine[]; readonly floorRows: readonly FloorOrderRow[] }): string => {
    const newestLine = g.lines[0]?.placedAt ?? "";
    const newestFloor = g.floorRows[0]?.createdAt ?? "";
    return newestLine > newestFloor ? newestLine : newestFloor;
  };
  groups.sort((a, b) => {
    const aNull = a.supplier === NEZNAMY_DODAVATEL;
    const bNull = b.supplier === NEZNAMY_DODAVATEL;
    if (aNull !== bNull) return aNull ? 1 : -1;
    const aNewest = groupNewest(a);
    const bNewest = groupNewest(b);
    if (aNewest !== bNewest) return aNewest > bNewest ? -1 : 1;
    return a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : 0;
  });
  return groups;
}

// issue 60: ID riadkov, ktoré `listOpenOrderLinesBySupplier` PRÁVE TERAZ
// zobrazuje pre JEDNÉHO dodávateľa — používa `modules/orders/state.ts`'s
// `setSupplierLinesOrdered` (hromadné označenie skupiny), aby hromadná akcia
// vždy dopadla presne na to, čo manažér na obrazovke "Na objednanie" vidí.
// Rovnaký filter (otvorené Shoptet stavy) a rovnaký zástupný kľúč
// (`NEZNAMY_DODAVATEL`) ako hlavný zoskupovací dopyt vyššie — zámerne
// SAMOSTATNÝ, užší dopyt (len ID, žiadne meno/veľkosť/odkaz na dodávateľa),
// nie filtrovanie výstupu `listOpenOrderLinesBySupplier` v pamäti, aby
// hromadná akcia nemusela ťahať VŠETKÝCH dodávateľov len kvôli jednému.
//
// Code review (review of PR 75, issue 60, finding 3): pôvodne bežal tento
// dopyt MIMO transakcie, ktorá potom vykonáva hromadný UPDATE — medzi
// prečítaním a zápisom mohol súbežný re-import objednávok alebo per-riadkové
// prepnutie stavu zmeniť, ktoré riadky sú pre daného dodávateľa "otvorené"
// (úzke TOCTOU okno, bez straty dát — zápis ide vždy na explicitné ID — ale
// hromadná akcia mohla občas zasiahnuť riadok, ktorý medzitým opustil/vstúpil
// do otvorenej skupiny). Volajúci (`state.ts`'s `setSupplierLinesOrdered`)
// teraz volá TENTO dopyt AŽ VNÚTRI vlastnej transakcie a `.for("update")`
// pokrýva aj `order` (viď `of` zoznam pri samotnom dopyte nižšie — od review
// of PR 76, finding 1 už NIE je bezzoznamový, pozri ten komentár pre presné
// dôvody a rozsah), takže súbežná zmena stavu objednávky (aj
// `setOrderLineState`'s vlastný `.for("update")` na `order_line`) musí
// počkať na COMMIT tejto transakcie, nie naopak. Parameter je preto zúžený
// na `Pick<Database, "select">` (rovnaký vzor ako `audit/service.ts`'s
// `AuditExecutor`) — `tx` (`PgTransaction`) nemá `Database`'s `$client`,
// takže by ho `tsc` odmietol ako celý `Database` (`.claude/rules/
// database.md`). Regresný dôkaz: `tests/orders-supplier-bulk-lock
// .integration.test.ts`.
export async function listOpenOrderLineIdsForSupplier(
  db: Pick<Database, "select">,
  supplier: string,
): Promise<readonly string[]> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return [];

  // issue 63: `supplier` je zobrazovaný (kanonický) reťazec, aký vrátil
  // `listOpenOrderLinesBySupplier` — porovnanie preto beží na TOM ISTOM
  // normalizovanom (case/whitespace-insensitive) kľúči, cez `effectiveSupplierSql`
  // (katalóg + ručné priradenie), inak by hromadná akcia nezasiahla riadky,
  // ktoré normalizácia zlúčila do tejto skupiny s INÝM pravopisom.
  const supplierFilter =
    supplier === NEZNAMY_DODAVATEL
      ? and(isNull(products.supplier), isNull(productSupplierOverrides.supplier))
      : eq(normalizedSupplierKeySql(effectiveSupplierSql), normalizeSupplierKeyJs(supplier));

  const rows = await db
    .select({ lineId: orderLines.id })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(productSupplierOverrides, eq(productSupplierOverrides.productKey, products.key))
    .where(and(inArray(orders.statusName, [...openStatuses]), supplierFilter))
    // Code review (review of PR 76, finding 1): `.for("update")` bez `of`
    // zoznamu zamyká VŠETKY štyri JOINnuté tabuľky (aj `variant`/`product`,
    // ktoré tento zápis vôbec nemutuje) — `catalog/ingest.ts` berie svoj
    // dlhý import v poradí product → variant (upsert produktov, potom
    // variantov, plus záverečný hromadný `UPDATE variant`), zatiaľ čo
    // LockRows uzol tohto dopytu by zamykal v poradí rozsahovej tabuľky
    // (order_line → order → variant → product) — opačné poradie zámkov medzi
    // dvomi transakciami je klasický predpoklad na deadlock. Zúženie na `of:
    // [orderLines, orders]` zachováva presne ten istý TOCTOU uzáver (viď
    // komentár vyššie + `.claude/rules/database.md`), bez zamykania
    // katalógových tabuliek, ktoré tento zápis nikdy nemení.
    .for("update", { of: [orderLines, orders] });

  return rows.map((row) => row.lineId);
}

// issue 480: predajňové produkty (`floor_note_product`) NEVYBAVENÝCH zápisov
// patriace jednému dodávateľovi — pre hromadné „označiť skupinu ako objednané"
// (`orders/state.ts`'s `setSupplierLinesOrdered`). Priamy náprotivok
// `listOpenOrderLineIdsForSupplier` vyššie: rovnaké override-aware,
// normalizované porovnanie dodávateľa (aj zástupná skupina `NEZNAMY_DODAVATEL`),
// samostatný úzky dopyt (len id + noteId), a `.for("update", { of:
// [floorNoteProducts] })` — zamyká LEN mutované floor riadky (nie katalógové
// `product`/`variant`), takže žiadna kolízia poradia zámkov s `catalog/ingest`
// (rovnaký dôvod ako `of: [orderLines, orders]` vyššie). `floorNoteId` sa vracia
// na následný prepočet note-level 🛒 (`recomputeFloorNoteOrdered`).
export async function listUnresolvedFloorProductIdsForSupplier(
  db: Pick<Database, "select">,
  supplier: string,
): Promise<readonly { readonly productId: string; readonly floorNoteId: string }[]> {
  const supplierFilter =
    supplier === NEZNAMY_DODAVATEL
      ? and(isNull(products.supplier), isNull(productSupplierOverrides.supplier))
      : eq(normalizedSupplierKeySql(effectiveSupplierSql), normalizeSupplierKeyJs(supplier));

  const rows = await db
    .select({ productId: floorNoteProducts.id, floorNoteId: floorNoteProducts.floorNoteId })
    .from(floorNoteProducts)
    .innerJoin(floorNotes, eq(floorNotes.id, floorNoteProducts.floorNoteId))
    .innerJoin(variants, eq(variants.code, floorNoteProducts.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(productSupplierOverrides, eq(productSupplierOverrides.productKey, products.key))
    .where(and(eq(floorNotes.resolved, false), supplierFilter))
    .for("update", { of: [floorNoteProducts] });

  return rows.map((row) => ({ productId: row.productId, floorNoteId: row.floorNoteId }));
}

// issue 476/484: odznak počtu v ľavom menu pre „Riešiť" — počet OTVORENÝCH
// (Shoptet stav ∈ `order_open_status`) DISTINCT OBJEDNÁVOK, ktoré majú aspoň
// jeden riadok v danom stave. Issue 484 (Štěpán): pôvodne (issue 476) počítal
// RIADKY, ale mentálny model je „koľko problémových OBJEDNÁVOK" — jedna
// objednávka s viacerými riesit riadkami (rôzne varianty/dodávatelia) sa teraz
// počíta RAZ. `countDistinct(order_line.order_id)` priamo v SQL (rovnaký vzor
// ako predtým `count()`), nie natiahnutie celého zoznamu a `.length` v JS —
// DB náprotivok `ordersSummary.ts`'s `countAffectedOrders`. `state` je parameter
// kvôli budúcej znovupoužiteľnosti, dnes ho volá len `riesit` count trasa.
export async function countOpenOrdersByState(db: Database, state: OrderLineState): Promise<number> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return 0;
  const [row] = await db
    .select({ total: countDistinct(orderLines.orderId) })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(inArray(orders.statusName, [...openStatuses]), eq(orderLines.state, state)));
  return row?.total ?? 0;
}

export interface OrderDetailLine {
  readonly lineId: string;
  readonly variantCode: string;
  readonly variantName: string;
  readonly sizeLabel: string | null;
  readonly supplier: string;
  readonly quantity: number;
  readonly state: OrderLineState;
  // issue 60: rovnaký nezávislý príznak ako `OpenOrderLine.ordered`.
  readonly ordered: boolean;
  // issue 70: tretia čítacia cesta zjednotená s `listOpenOrderLinesBySupplier`
  // a `mail.ts`'s `loadOutstandingLines` — rovnaký zámer, rovnaké polia.
  readonly supplierUrl: string | null;
  readonly supplierNote: string | null;
  readonly externalCode: string | null;
}

export interface OrderDetail {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly comment: string | null;
  readonly placedAt: string;
  readonly lines: readonly OrderDetailLine[];
}

export async function getOrderDetail(db: Database, id: string): Promise<OrderDetail | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (order === undefined) return null;

  const lineRows = await db
    .select({
      lineId: orderLines.id,
      variantCode: orderLines.variantCode,
      variantName: variants.name,
      sizeLabel: variants.sizeLabel,
      effectiveSupplier: effectiveSupplierSql,
      quantity: orderLines.quantity,
      state: orderLines.state,
      ordered: orderLines.ordered,
      internalNote: products.internalNote,
      supplierLinkOverride: productSupplierLinkOverrides.url,
      externalCode: variants.externalCode,
    })
    .from(orderLines)
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .leftJoin(productSupplierOverrides, eq(productSupplierOverrides.productKey, products.key))
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key))
    .where(eq(orderLines.orderId, id))
    // issue 63: `effectiveSupplier` (override-aware) nahradilo priame
    // `products.supplier` v `ORDER BY` — poradie riadkov v detaile objednávky
    // nie je nikde testom overované na presnú hodnotu, len na to, že sa
    // zobrazí SPRÁVNY (aktuálny) dodávateľ na riadok.
    .orderBy(asc(variants.code));

  return {
    id: order.id,
    externalOrderId: order.externalOrderId,
    customerName: order.customerName,
    comment: order.comment,
    placedAt: order.placedAt.toISOString(),
    lines: lineRows.map((row) => {
      const supplierLink = resolveEffectiveSupplierLink(row.internalNote, row.supplierLinkOverride);
      return {
        lineId: row.lineId,
        variantCode: row.variantCode,
        variantName: row.variantName,
        sizeLabel: row.sizeLabel,
        supplier: row.effectiveSupplier ?? NEZNAMY_DODAVATEL,
        quantity: row.quantity,
        state: row.state,
        ordered: row.ordered,
        supplierUrl: supplierLink.url,
        supplierNote: supplierLink.note,
        externalCode: row.externalCode,
      };
    }),
  };
}
