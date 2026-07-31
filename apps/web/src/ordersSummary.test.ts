import { expect, it } from "vitest";
import {
  computeVariantTotals,
  formatOrderSummaryText,
  formatVariantTotalChip,
  isLineResolved,
  isStaleOrderLine,
  orderLineAgeDays,
  STALE_ORDER_LINE_DAYS,
  summarizeOrderLines,
} from "./ordersSummary.js";

const line = (state: "objednane" | "caka_sa" | "skladom" | "nedostupne", ordered: boolean) => ({
  state,
  ordered,
});

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
// celý vybavený, by preto navždy visel s "Σ spolu 0 ks".
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
    text: "Σ spolu 3 ks",
    title: "Spolu vo všetkých objednávkach: 5 ks · nevybavené: 3 ks",
  });
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
