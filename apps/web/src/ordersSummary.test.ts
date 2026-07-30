import { expect, it } from "vitest";
import { formatOrderSummaryText, isLineResolved, summarizeOrderLines } from "./ordersSummary.js";

const line = (state: "objednane" | "caka_sa" | "skladom" | "nedostupne", ordered: boolean) => ({
  state,
  ordered,
});

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
