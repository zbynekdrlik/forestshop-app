import { expect, it } from "vitest";
import {
  computeVariantTotals,
  countAffectedOrders,
  formatItemCount,
  formatOrderCount,
  formatOrderSummaryText,
  formatVariantTotalChip,
  isLineHiddenByFilter,
  isLineResolved,
  isStaleOrderLine,
  oldestWaitingPlacedAt,
  orderLineAgeDays,
  sortSuppliersForChips,
  STALE_ORDER_LINE_DAYS,
  summarizeOrderLines,
} from "./ordersSummary.js";

const line = (
  state: "objednane" | "caka_sa" | "skladom" | "nedostupne",
  ordered: boolean,
  quantity = 1,
) => ({
  state,
  ordered,
  quantity,
});

const overviewLine = (
  orderId: string,
  state: "objednane" | "caka_sa" | "skladom" | "nedostupne",
  ordered: boolean,
  placedAt = "2026-01-01T00:00:00.000Z",
) => ({ orderId, state, ordered, placedAt });

const variantLine = (
  variantCode: string,
  quantity: number,
  state: "objednane" | "caka_sa" | "skladom" | "nedostupne",
  ordered: boolean,
) => ({ variantCode, quantity, state, ordered });

it("riadok v predvolenom stave a bez odškrtnutia je NEvybavený", () => {
  expect(isLineResolved(line("objednane", false))).toBe(false);
});

it("riadok odškrtnutý ako objednané je vybavený, aj keď je stav stále predvolený", () => {
  expect(isLineResolved(line("objednane", true))).toBe(true);
});

it("riadok posunutý za predvolený stav je vybavený, aj bez odškrtnutia", () => {
  expect(isLineResolved(line("caka_sa", false))).toBe(true);
  expect(isLineResolved(line("skladom", false))).toBe(true);
  expect(isLineResolved(line("nedostupne", false))).toBe(true);
});

// issue 149 — priame testy jediného zdieľaného predikátu (`OrdersSection.tsx`'s
// `visibleLinesCount` a `SupplierOrderGroup.tsx`'s `visibleLines` naň oba
// spoliehajú), review nález (code review na PR 154): predtým bol overený len
// nepriamo cez komponentové/e2e testy.
it("isLineHiddenByFilter: hideResolved=false nikdy nič neskryje, bez ohľadu na stav/dirty", () => {
  expect(isLineHiddenByFilter({ ...line("caka_sa", false), lineId: "x" }, false, new Set())).toBe(false);
  expect(isLineHiddenByFilter({ ...line("objednane", false), lineId: "x" }, false, new Set())).toBe(false);
});

it("isLineHiddenByFilter: hideResolved=true skryje vybavený riadok BEZ otvorenej úpravy", () => {
  expect(isLineHiddenByFilter({ ...line("caka_sa", false), lineId: "x" }, true, new Set())).toBe(true);
});

it("isLineHiddenByFilter: hideResolved=true NEVYBAVENÝ riadok nikdy neskryje", () => {
  expect(isLineHiddenByFilter({ ...line("objednane", false), lineId: "x" }, true, new Set())).toBe(false);
});

it("isLineHiddenByFilter: vybavený riadok s otvorenou úpravou (dirtyEditorLineIds) ostáva viditeľný", () => {
  expect(isLineHiddenByFilter({ ...line("caka_sa", false), lineId: "x" }, true, new Set(["x"]))).toBe(false);
  // Iný riadok v tom istom sete zostáva skrytý — výnimka je per-lineId, nie globálna.
  expect(isLineHiddenByFilter({ ...line("caka_sa", false), lineId: "y" }, true, new Set(["x"]))).toBe(true);
});

it("summarizeOrderLines spočíta total/remaining a rozpis podľa stavov/odškrtnutia", () => {
  const summary = summarizeOrderLines([
    line("objednane", false), // nevybavený → remaining
    line("caka_sa", false),
    line("skladom", false),
    line("nedostupne", false),
    line("objednane", true), // odškrtnutý, stav stále predvolený → ordered bucket, nie remaining
  ]);

  expect(summary).toEqual({ total: 5, remaining: 1, ordered: 1, waiting: 1, stock: 1, unavailable: 1 });
});

it("rozpis NIE JE rozklad total na disjunktné časti — riadok môže byť v OBOCH bucketoch naraz", () => {
  // odškrtnutý AJ v stave "čaká sa" súčasne — počíta sa do OBOCH, total ostáva 1.
  const summary = summarizeOrderLines([line("caka_sa", true)]);

  expect(summary).toEqual({ total: 1, remaining: 0, ordered: 1, waiting: 1, stock: 0, unavailable: 0 });
});

// issue 260 — majiteľ: "sú tam 2 rovnaké čelovky, ale ukazuje len jednu".
// `ingest.ts` sčíta ten istý produkt v tej istej objednávke do JEDNÉHO
// `order_line` s `quantity: 2` (`.claude/rules/orders.md`) — `total`/
// `remaining` preto MUSIA sčítať `quantity`, nie počítať riadky. Pred
// opravou by táto asercia zlyhala (`total`/`remaining` by boli 1, nie 2) —
// dôkaz, že tento test naozaj chybu odhalí, nielen potvrdí kód.
it("summarizeOrderLines sčíta MNOŽSTVÁ, nie počet riadkov — dva rovnaké kusy na JEDNOM riadku sa počítajú ako 2", () => {
  const summary = summarizeOrderLines([line("objednane", false, 2)]);

  expect(summary).toEqual({ total: 2, remaining: 2, ordered: 0, waiting: 0, stock: 0, unavailable: 0 });
});

// Druhý tvar toho istého bugu: dva RÔZNE riadky (rôzne objednávky) toho
// istého produktu musia svoje množstvá tiež SČÍTAŤ, nielen spočítať riadky.
it("summarizeOrderLines sčíta množstvá naprieč VIACERÝMI riadkami rovnakého produktu", () => {
  const summary = summarizeOrderLines([line("objednane", false, 3), line("objednane", false, 1)]);

  expect(summary.total).toBe(4);
  expect(summary.remaining).toBe(4);
});

// `ordered`/`waiting`/`stock`/`unavailable` rozpis musí byť konzistentný s
// `total`/`remaining` — aj TIETO bucket-y počítajú kusy, nie riadky (inak by
// súčet rozpisu pri jednom viac-kusovom riadku pôsobil nezmyselne malý oproti
// `total`).
it("summarizeOrderLines — rozpis podľa stavu/odškrtnutia tiež sčíta množstvo, nie riadky", () => {
  const summary = summarizeOrderLines([line("caka_sa", true, 5)]);

  expect(summary).toEqual({ total: 5, remaining: 0, ordered: 5, waiting: 5, stock: 0, unavailable: 0 });
});

it("formatOrderSummaryText bez vybraného dodávateľa a bez rozpisu (žiadny bucket nenulový)", () => {
  const summary = summarizeOrderLines([line("objednane", false)]);
  expect(formatOrderSummaryText(summary, null)).toBe("Ostáva vybaviť 1 z 1");
});

it("formatOrderSummaryText s vybraným dodávateľom pridá jeho meno pred súhrn", () => {
  const summary = summarizeOrderLines([line("caka_sa", false)]);
  expect(formatOrderSummaryText(summary, "DODAVATEL-TEST-1")).toBe(
    "DODAVATEL-TEST-1: ostáva vybaviť 0 z 1 · Čaká sa 1",
  );
});

it("formatOrderSummaryText vynechá nulové bucketa, zachová poradie neprázdnych", () => {
  const summary = summarizeOrderLines([
    line("objednane", false),
    line("skladom", false),
    line("nedostupne", true), // ordered aj nedostupné naraz
  ]);
  expect(formatOrderSummaryText(summary, null)).toBe("Ostáva vybaviť 1 z 3 · Objednané 1 · Skladom 1 · Nedostupné 1");
});

// issue 62 — súčet kusov toho istého produktu (`variantCode`) naprieč
// riadkami dodávateľa.
it("computeVariantTotals zoskupí podľa variantCode a spočíta total aj remaining zvlášť", () => {
  const totals = computeVariantTotals([
    variantLine("4859/46", 3, "objednane", false), // nevybavený → počíta sa aj do remaining
    variantLine("4859/46", 2, "skladom", false), // vybavený (posunutý stav) → NIE do remaining
    variantLine("40287", 1, "objednane", false), // iný produkt, samostatná skupina
  ]);
  expect(totals.get("4859/46")).toEqual({ total: 5, remaining: 3, lineCount: 2 });
  expect(totals.get("40287")).toEqual({ total: 1, remaining: 1, lineCount: 1 });
});

it("computeVariantTotals — odškrtnuté 'objednané' sa počíta ako vybavené (rovnaká definícia ako isLineResolved)", () => {
  const totals = computeVariantTotals([
    variantLine("4859/46", 3, "objednane", true), // odškrtnutý, stav stále predvolený → vybavený
    variantLine("4859/46", 2, "objednane", false),
  ]);
  expect(totals.get("4859/46")).toEqual({ total: 5, remaining: 2, lineCount: 2 });
});

it("formatVariantTotalChip vráti null, keď produkt má v skupine LEN jeden riadok (žiadny chip)", () => {
  const totals = computeVariantTotals([variantLine("40287", 1, "objednane", false)]);
  const vt = totals.get("40287");
  if (vt === undefined) throw new Error("40287 musí byť v mape");
  expect(formatVariantTotalChip(vt)).toBeNull();
});

// issue 63 (nález pri kontrole issue 62): chip sa doteraz rozhodoval LEN
// podľa `lineCount < 2`, nie podľa zvyšku — opakovaný produkt, ktorý je UŽ
// celý vybavený, by preto navždy visel s "Σ 0 ks".
it("formatVariantTotalChip vráti null, keď je produkt s ≥2 riadkami UŽ CELÝ vybavený (remaining === 0)", () => {
  const totals = computeVariantTotals([
    variantLine("4859/46", 3, "objednane", true), // odškrtnutý → vybavený
    variantLine("4859/46", 2, "skladom", false), // posunutý stav → vybavený
  ]);
  const vt = totals.get("4859/46");
  if (vt === undefined) throw new Error("4859/46 musí byť v mape");
  expect(vt.remaining).toBe(0);
  expect(formatVariantTotalChip(vt)).toBeNull();
});

it("formatVariantTotalChip s ≥2 riadkami vráti text so ZOSTÁVAJÚCIM množstvom a tooltip s CELKOVÝM aj zostávajúcim", () => {
  const totals = computeVariantTotals([
    variantLine("4859/46", 3, "objednane", false),
    variantLine("4859/46", 2, "skladom", false),
  ]);
  const vt = totals.get("4859/46");
  if (vt === undefined) throw new Error("4859/46 musí byť v mape");
  const chip = formatVariantTotalChip(vt);
  expect(chip).toEqual({
    // issue 214: bez jednotky — tá je už na riadku nad pilulkou ("3 ks").
    text: "Σ 3",
    title: "Spolu vo všetkých objednávkach: 5 ks · nevybavené: 3 ks",
  });
});

// issue 214: pilulka sa musí zmestiť do najužšej reálnej šírky stĺpca s
// množstvom (nameraných 33 px voľného miesta pri 1280 px okna), inak ju
// `text-overflow: ellipsis` oreže na "Σ…" a majiteľ z nej nič neprečíta.
// Trojciferný súčet je najhorší reálny prípad, aký katalóg dnes vie vyrobiť.
it("formatVariantTotalChip drží text krátky aj pri trojcifernom súčte", () => {
  const totals = computeVariantTotals([
    variantLine("4859/46", 500, "objednane", false),
    variantLine("4859/46", 128, "caka_sa", false),
  ]);
  const vt = totals.get("4859/46");
  if (vt === undefined) throw new Error("4859/46 musí byť v mape");
  const chip = formatVariantTotalChip(vt);
  expect(chip?.text.length).toBeLessThanOrEqual(6);
});

// issue 65 — vek nevybaveného riadku + hranica upozornenia (⚠️).
const NOW = new Date("2026-08-01T00:00:00Z");

it("orderLineAgeDays vypočíta počet celých dní od placedAt po now", () => {
  expect(orderLineAgeDays("2026-07-01T00:00:00Z", NOW)).toBe(31);
  expect(orderLineAgeDays("2026-08-01T00:00:00Z", NOW)).toBe(0);
});

it("orderLineAgeDays nikdy nevráti záporné číslo (placedAt v budúcnosti)", () => {
  expect(orderLineAgeDays("2026-08-05T00:00:00Z", NOW)).toBe(0);
});

it("STALE_ORDER_LINE_DAYS je 14 (rovnaká hranica ako stará appka's STALE_ORDER_DAYS)", () => {
  expect(STALE_ORDER_LINE_DAYS).toBe(14);
});

// Presná hranica žiadaná ticketom: 14 dní → BEZ badge, 15 dní → S badge.
it("isStaleOrderLine — presne 14 dní starý nevybavený riadok NEDOSTANE badge", () => {
  const placedAt = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
  expect(isStaleOrderLine({ state: "objednane", ordered: false, placedAt }, NOW)).toBe(false);
});

it("isStaleOrderLine — presne 15 dní starý nevybavený riadok DOSTANE badge", () => {
  const placedAt = new Date(NOW.getTime() - 15 * 86_400_000).toISOString();
  expect(isStaleOrderLine({ state: "objednane", ordered: false, placedAt }, NOW)).toBe(true);
});

it("isStaleOrderLine — vybavený riadok (odškrtnutý alebo posunutý stav) NIKDY nedostane badge, aj keby bol veľmi starý", () => {
  const staryDatum = new Date(NOW.getTime() - 100 * 86_400_000).toISOString();
  expect(isStaleOrderLine({ state: "objednane", ordered: true, placedAt: staryDatum }, NOW)).toBe(false);
  expect(isStaleOrderLine({ state: "caka_sa", ordered: false, placedAt: staryDatum }, NOW)).toBe(false);
});

it("isStaleOrderLine — čerstvý nevybavený riadok nedostane badge", () => {
  expect(isStaleOrderLine({ state: "objednane", ordered: false, placedAt: NOW.toISOString() }, NOW)).toBe(false);
});

// issue 105 bod 2's `shouldShowSizeLabel` tests boli odstránené spolu s
// funkciou samotnou — issue 117 zrušilo jej jediné volanie miesto
// (`OrderLineRow.tsx`'s KÓD stĺpec), takže ostala nepoužitá (code review
// PR #124).

// issue 237: "Súhrn o objednávaní" — počet DOTKNUTÝCH objednávok a dátum
// najstaršej čakajúcej.

it("countAffectedOrders — dve nevybavené riadky TEJ ISTEJ objednávky sa počítajú raz", () => {
  const lines = [overviewLine("O1", "objednane", false), overviewLine("O1", "caka_sa", false)];
  expect(countAffectedOrders(lines)).toBe(1);
});

it("countAffectedOrders — nevybavené riadky RÔZNYCH objednávok sa počítajú zvlášť", () => {
  const lines = [overviewLine("O1", "objednane", false), overviewLine("O2", "objednane", false)];
  expect(countAffectedOrders(lines)).toBe(2);
});

it("countAffectedOrders — vybavený riadok (odškrtnutý alebo posunutý stav) sa nepočíta", () => {
  const lines = [overviewLine("O1", "objednane", true), overviewLine("O2", "skladom", false)];
  expect(countAffectedOrders(lines)).toBe(0);
});

it("countAffectedOrders — objednávka s VYBAVENÝM aj NEVYBAVENÝM riadkom sa počíta raz (má aspoň jeden nevybavený)", () => {
  const lines = [overviewLine("O1", "objednane", true), overviewLine("O1", "objednane", false)];
  expect(countAffectedOrders(lines)).toBe(1);
});

it("countAffectedOrders — prázdny zoznam vráti 0", () => {
  expect(countAffectedOrders([])).toBe(0);
});

it("oldestWaitingPlacedAt — vráti placedAt najstaršieho NEVYBAVENÉHO riadku", () => {
  const lines = [
    overviewLine("O1", "objednane", false, "2026-06-01T00:00:00.000Z"),
    overviewLine("O2", "objednane", false, "2026-01-15T00:00:00.000Z"),
    overviewLine("O3", "objednane", false, "2026-03-10T00:00:00.000Z"),
  ];
  expect(oldestWaitingPlacedAt(lines)).toBe("2026-01-15T00:00:00.000Z");
});

it("oldestWaitingPlacedAt — ignoruje VYBAVENÉ riadky, aj keby boli staršie", () => {
  const lines = [
    overviewLine("O1", "objednane", true, "2020-01-01T00:00:00.000Z"), // vybavené, staršie
    overviewLine("O2", "objednane", false, "2026-01-15T00:00:00.000Z"),
  ];
  expect(oldestWaitingPlacedAt(lines)).toBe("2026-01-15T00:00:00.000Z");
});

it("oldestWaitingPlacedAt — žiadny nevybavený riadok vráti null", () => {
  expect(oldestWaitingPlacedAt([overviewLine("O1", "objednane", true)])).toBeNull();
  expect(oldestWaitingPlacedAt([])).toBeNull();
});

// issue 237 (code review, minor): slovenský počítateľný tvar — 1 → jednotné
// číslo, 2-4 → málopočetné (paucal), 0/5+ (vrátane 22/23/24…) → rodový pád
// množného čísla.
it("formatOrderCount — 1 je jednotné číslo", () => {
  expect(formatOrderCount(1)).toBe("1 objednávka");
});

it("formatOrderCount — 2, 3, 4 sú málopočetné (paucal)", () => {
  expect(formatOrderCount(2)).toBe("2 objednávky");
  expect(formatOrderCount(3)).toBe("3 objednávky");
  expect(formatOrderCount(4)).toBe("4 objednávky");
});

it("formatOrderCount — 0, 5+ (vrátane 22/23/24) sú rodový pád množného čísla", () => {
  expect(formatOrderCount(0)).toBe("0 objednávok");
  expect(formatOrderCount(5)).toBe("5 objednávok");
  expect(formatOrderCount(22)).toBe("22 objednávok");
  expect(formatOrderCount(23)).toBe("23 objednávok");
  expect(formatOrderCount(24)).toBe("24 objednávok");
});

// issue 484 — počet položiek na kompaktnom riadku sekcie „Riešiť", rovnaký
// slovenský 3-tvarový paucal ako `formatOrderCount`.
it("formatItemCount — 1 / 2-4 / 0,5+ (paucal položka)", () => {
  expect(formatItemCount(1)).toBe("1 položka");
  expect(formatItemCount(2)).toBe("2 položky");
  expect(formatItemCount(4)).toBe("4 položky");
  expect(formatItemCount(0)).toBe("0 položiek");
  expect(formatItemCount(5)).toBe("5 položiek");
  expect(formatItemCount(23)).toBe("23 položiek");
});

// issue 452 — dodávateľské čipy zoradené abecedne (slovenské locale,
// case-insensitive), "(bez dodávateľa)" naposledy.
const group = (supplier: string) => ({ supplier });

it("sortSuppliersForChips — zoradí abecedne bez ohľadu na veľkosť písmen", () => {
  const zoradené = sortSuppliersForChips([group("WETLAND"), group("betalov"), group("Forest")]);
  expect(zoradené.map((g) => g.supplier)).toEqual(["betalov", "Forest", "WETLAND"]);
});

it("sortSuppliersForChips — rešpektuje slovenskú diakritiku (c < č < d, s < š)", () => {
  // Naivné `.sort()` podľa kódových bodov by dalo Cesnak, Dubák, Čučoriedka
  // (Č=268 > D=68) — slovenské locale musí dať c < č < d.
  const zoradené = sortSuppliersForChips([group("Dubák"), group("Cesnak"), group("Čučoriedka")]);
  expect(zoradené.map((g) => g.supplier)).toEqual(["Cesnak", "Čučoriedka", "Dubák"]);

  const sStavy = sortSuppliersForChips([group("Švošov"), group("Sokol"), group("Turie")]);
  expect(sStavy.map((g) => g.supplier)).toEqual(["Sokol", "Švošov", "Turie"]);
});

it("sortSuppliersForChips — '(bez dodávateľa)' ostáva vždy naposledy", () => {
  const zoradené = sortSuppliersForChips([
    group("(bez dodávateľa)"),
    group("WETLAND"),
    group("BETALOV"),
  ]);
  expect(zoradené.map((g) => g.supplier)).toEqual(["BETALOV", "WETLAND", "(bez dodávateľa)"]);
});

it("sortSuppliersForChips — reprodukuje poradie zo zadania (Štěpánov screenshot)", () => {
  const vstup = [
    "BETALOV", "Hunting & Fishing", "LOVTEK", "ROY", "OUTHUNT", "Forest", "WETLAND",
    "TRIGONA", "GRUBE", "ODIMON", "LESONA", "ZUBÍČEK", "FOMEI SLOVAKIA", "WERRA",
    "ROSLER", "Drevo Novák", "TTHUNT", "SOXLAND",
  ].map(group);
  const prvé5 = sortSuppliersForChips(vstup).slice(0, 5).map((g) => g.supplier);
  expect(prvé5).toEqual(["BETALOV", "Drevo Novák", "FOMEI SLOVAKIA", "Forest", "GRUBE"]);
});

it("sortSuppliersForChips — nemení vstupné pole (vráti novú kópiu)", () => {
  const vstup = [group("WETLAND"), group("BETALOV")];
  const zoradené = sortSuppliersForChips(vstup);
  expect(vstup.map((g) => g.supplier)).toEqual(["WETLAND", "BETALOV"]);
  expect(zoradené).not.toBe(vstup);
});
