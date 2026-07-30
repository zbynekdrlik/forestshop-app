import { expect, it } from "vitest";
import { PairingUnauthorizedError, type PairingItem } from "./pairingApi.js";
import {
  assertBulkConfirmSucceeded,
  groupConfirmation,
  groupPairingItems,
  isGroupFullyConfirmed,
  isGroupHomogeneous,
} from "./pairingGroups.js";

function item(overrides: Partial<PairingItem> & { variantCode: string; productKey: string }): PairingItem {
  return {
    variantName: "Test produkt",
    sizeLabel: null,
    productName: "Test produkt",
    productSupplier: null,
    supplierUrl: null,
    state: "navrhnute",
    confirmedByName: null,
    confirmedAt: null,
    ...overrides,
  };
}

it("zoskupí varianty podľa productKey, v poradí prvého výskytu produktu", () => {
  const items = [
    item({ variantCode: "40237/M", productKey: "40237" }),
    item({ variantCode: "40238/S", productKey: "40238" }),
    item({ variantCode: "40237/L", productKey: "40237" }),
  ];

  const groups = groupPairingItems(items);

  expect(groups.map((g) => g.productKey)).toEqual(["40237", "40238"]);
  expect(groups[0]?.variants.map((v) => v.variantCode)).toEqual(["40237/M", "40237/L"]);
  expect(groups[1]?.variants.map((v) => v.variantCode)).toEqual(["40238/S"]);
});

it("produkt s jedným variantom je vždy homogénny a nesie jeho productName", () => {
  const groups = groupPairingItems([
    item({ variantCode: "40287", productKey: "40287", productName: "Čiapka Polar FOREST" }),
  ]);

  expect(groups).toHaveLength(1);
  expect(groups[0]?.productName).toBe("Čiapka Polar FOREST");
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(isGroupHomogeneous(group)).toBe(true);
});

it("skupina so ZHODNOU adresou na všetkých variantoch je homogénna (nerozdelená)", () => {
  const groups = groupPairingItems([
    item({ variantCode: "40237/M", productKey: "40237", supplierUrl: "https://x.sk/1" }),
    item({ variantCode: "40237/L", productKey: "40237", supplierUrl: "https://x.sk/1" }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(isGroupHomogeneous(group)).toBe(true);
});

it("skupina bez ŽIADNEJ uloženej adresy (všetky null) je tiež homogénna", () => {
  const groups = groupPairingItems([
    item({ variantCode: "40237/M", productKey: "40237" }),
    item({ variantCode: "40237/L", productKey: "40237" }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(isGroupHomogeneous(group)).toBe(true);
});

it("skupina s RÔZNYMI adresami je efektívne rozdelená (nie homogénna)", () => {
  const groups = groupPairingItems([
    item({ variantCode: "40237/M", productKey: "40237", supplierUrl: "https://x.sk/1" }),
    item({ variantCode: "40237/L", productKey: "40237", supplierUrl: "https://x.sk/2" }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(isGroupHomogeneous(group)).toBe(false);
});

it("isGroupFullyConfirmed vyžaduje POTVRDENÉ na KAŽDOM variante", () => {
  const groups = groupPairingItems([
    item({ variantCode: "40237/M", productKey: "40237", state: "potvrdene" }),
    item({ variantCode: "40237/L", productKey: "40237", state: "navrhnute" }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(isGroupFullyConfirmed(group)).toBe(false);
});

it("groupConfirmation vráti spoločnú atribúciu, keď je zhodná na všetkých variantoch", () => {
  const groups = groupPairingItems([
    item({
      variantCode: "40237/M",
      productKey: "40237",
      state: "potvrdene",
      confirmedByName: "Manažér",
      confirmedAt: "2026-07-30T10:00:00.000Z",
    }),
    item({
      variantCode: "40237/L",
      productKey: "40237",
      state: "potvrdene",
      confirmedByName: "Manažér",
      confirmedAt: "2026-07-30T10:00:00.000Z",
    }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(groupConfirmation(group)).toEqual({ confirmedByName: "Manažér", confirmedAt: "2026-07-30T10:00:00.000Z" });
});

// Live overenie na issue 47: bulk potvrdenie je N samostatných POST volaní,
// každé s vlastným `now = new Date()` na serveri — `confirmedAt` sa preto
// medzi variantmi takmer VŽDY líši o pár milisekúnd, aj keď ide o TEN ISTÝ
// bulk úkon TEJ ISTEJ osoby. `groupConfirmation` preto porovnáva LEN meno,
// nikdy presný čas — inak by "Potvrdil" po KAŽDOM bulk potvrdení ukazovalo
// "—" namiesto mena (reálne pozorované pri post-deploy overení na prod).
it("groupConfirmation vráti meno aj pri MIERNE odlišnom confirmedAt (bulk potvrdenie, tá istá osoba) — NAJSTARŠÍ čas", () => {
  const groups = groupPairingItems([
    item({
      variantCode: "40237/M",
      productKey: "40237",
      state: "potvrdene",
      confirmedByName: "Manažér",
      confirmedAt: "2026-07-30T10:00:00.050Z",
    }),
    item({
      variantCode: "40237/L",
      productKey: "40237",
      state: "potvrdene",
      confirmedByName: "Manažér",
      confirmedAt: "2026-07-30T10:00:00.010Z",
    }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(groupConfirmation(group)).toEqual({ confirmedByName: "Manažér", confirmedAt: "2026-07-30T10:00:00.010Z" });
});

it("groupConfirmation vráti null, keď sa atribúcia medzi variantmi LÍŠI (zmiešaná skupina)", () => {
  const groups = groupPairingItems([
    item({
      variantCode: "40237/M",
      productKey: "40237",
      state: "potvrdene",
      confirmedByName: "Manažér A",
      confirmedAt: "2026-07-30T10:00:00.000Z",
    }),
    item({
      variantCode: "40237/L",
      productKey: "40237",
      state: "potvrdene",
      confirmedByName: "Manažér B",
      confirmedAt: "2026-07-30T11:00:00.000Z",
    }),
  ]);
  const group = groups[0];
  if (group === undefined) throw new Error("group missing");
  expect(groupConfirmation(group)).toEqual({ confirmedByName: null, confirmedAt: null });
});

it("assertBulkConfirmSucceeded neurobí nič, keď VŠETKY sľuby uspeli", () => {
  const results: PromiseSettledResult<void>[] = [
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined },
  ];
  expect(() => { assertBulkConfirmSucceeded(["a", "b"], results); }).not.toThrow();
});

it("assertBulkConfirmSucceeded pri ÚPLNOM zlyhaní hlási pôvodnú hlášku bez počtu", () => {
  const results: PromiseSettledResult<void>[] = [
    { status: "rejected", reason: new Error("Chýba adresa produktu u dodávateľa") },
    { status: "rejected", reason: new Error("Chýba adresa produktu u dodávateľa") },
  ];
  expect(() => { assertBulkConfirmSucceeded(["a", "b"], results); }).toThrow(
    "Chýba adresa produktu u dodávateľa",
  );
});

it("assertBulkConfirmSucceeded pri ČIASTOČNOM zlyhaní pridá počet zlyhaných", () => {
  const results: PromiseSettledResult<void>[] = [
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: new Error("Variant sa nenašiel") },
  ];
  expect(() => { assertBulkConfirmSucceeded(["a", "b"], results); }).toThrow(
    "Variant sa nenašiel (zlyhalo 1 z 2 veľkostí)",
  );
});

it("assertBulkConfirmSucceeded prehodí TÚ ISTÚ PairingUnauthorizedError inštanciu (nikdy nezabalenú)", () => {
  const unauthorized = new PairingUnauthorizedError();
  const results: PromiseSettledResult<void>[] = [{ status: "rejected", reason: unauthorized }];
  try {
    assertBulkConfirmSucceeded(["a"], results);
    throw new Error("malo vyhodiť");
  } catch (err) {
    expect(err).toBe(unauthorized);
  }
});
