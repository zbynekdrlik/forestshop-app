import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeCp1250,
  EMPTY_ORDER_LEVEL_EXTRA,
  extractOrderIdsFromXml,
  extractOrderLevelExtra,
  mapOrderRow,
  mergeOrderLevelExtra,
  normalizeStatusName,
  parseDelimited,
  parseShopLocalDateTime,
  parseShoptetOrdersCsv,
  REQUIRED_ORDER_COLUMNS,
} from "./parser.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/orders-sample.csv", import.meta.url)),
);

const XML_FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/orders-sample.xml", import.meta.url)),
  "utf-8",
);

describe("decodeCp1250 + parseDelimited", () => {
  it("dekóduje windows-1250 diakritiku správne", () => {
    const text = decodeCp1250(Buffer.from([0x8a, 0x69, 0x6c, 0x74, 0x6f, 0x76, 0x6b, 0x61])); // "Šiltovka"
    expect(text).toBe("Šiltovka");
  });

  it("rozparsuje bunku so zalomením riadku vnútri úvodzoviek ako JEDEN záznam", () => {
    const csv = 'a;"b\r\nc";d\r\n';
    const rows = [...parseDelimited(csv)];
    expect(rows).toEqual([["a", "b\r\nc", "d"]]);
  });

  it("zdvojená úvodzovka vnútri bunky sa dekóduje na jednu", () => {
    const csv = '"He said ""hi""";x\r\n';
    const rows = [...parseDelimited(csv)];
    expect(rows[0]).toEqual(['He said "hi"', "x"]);
  });

  it("vyhodí, keď súbor skončí vnútri nezatvorenej zacitovanej bunky", () => {
    const csv = 'a;"neukoncene';
    expect(() => [...parseDelimited(csv)]).toThrow(/neúplný/);
  });
});

describe("parseShoptetOrdersCsv (fixtúra)", () => {
  it("prečíta hlavičku s koncovým prázdnym stĺpcom (bodkočiarka na konci riadku)", () => {
    const csv = parseShoptetOrdersCsv(FIXTURE);
    expect(csv.columns).toContain("code");
    expect(csv.columns).toContain("itemCode");
    expect(csv.columns[csv.columns.length - 1]).toBe("");
    for (const required of REQUIRED_ORDER_COLUMNS) expect(csv.columns).toContain(required);
  });

  it("prečíta presne 7 dátových riadkov z fixtúry", () => {
    const csv = parseShoptetOrdersCsv(FIXTURE);
    expect([...csv.rows()]).toHaveLength(7);
  });
});

describe("mapOrderRow — reálna položka", () => {
  it("zmapuje riadok s reálnym produktom na kandidáta", () => {
    const csv = parseShoptetOrdersCsv(FIXTURE);
    const rows = [...csv.rows()];
    const real = rows.find((r) => r["itemCode"] === "40237/XL" && r["itemAmount"] === "2");
    if (real === undefined) throw new Error("fixtúra nemá očakávaný riadok");
    const mapped = mapOrderRow(real);
    expect(mapped.issue).toBeNull();
    expect(mapped.record).not.toBeNull();
    expect(mapped.record?.externalOrderId).toBe("20300001");
    expect(mapped.record?.variantCode).toBe("40237/XL");
    expect(mapped.record?.quantity).toBe(2);
    expect(mapped.record?.customerName).toBe("Ján Novák");
    // issue 59: fixtúra nesie order 20300001 v stave "Vybavuje sa".
    expect(mapped.record?.statusName).toBe("Vybavuje sa");
    // issue 65: fixtúra nesie order 20300001 so zákazníckym odkazom (`remark`
    // stĺpec — NIE `shopRemark`, `.claude/rules/orders.md`).
    expect(mapped.record?.remark).toBe("Prosím doručiť len v piatok, ďakujem");
  });

  // issue 65: order 20300002 (fixtúra) nemá vyplnený `remark` — prázdny
  // (po orezaní) stĺpec sa mapuje na `null`, nikdy na prázdny reťazec.
  it("prázdny remark sa mapuje na null, nie na prázdny reťazec", () => {
    const csv = parseShoptetOrdersCsv(FIXTURE);
    const rows = [...csv.rows()];
    const real = rows.find((r) => r["itemCode"] === "40238/M");
    if (real === undefined) throw new Error("fixtúra nemá očakávaný riadok");
    const mapped = mapOrderRow(real);
    expect(mapped.record?.remark).toBeNull();
  });

  // issue 65: chýbajúci stĺpec `remark` úplne (nie len prázdny) sa má
  // správať rovnako ako prázdny — appka nesmie spadnúť na chýbajúcom
  // nepovinnom stĺpci exportu.
  it("chýbajúci stĺpec remark na riadku → null (nikdy nevyhodí)", () => {
    const mapped = mapOrderRow({
      code: "20300006",
      date: "2026-06-16 08:00:00",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40238/M",
    });
    expect(mapped.record?.remark).toBeNull();
  });

  it("remark s okolitými medzerami sa orezáva", () => {
    const mapped = mapOrderRow({
      code: "20300007",
      date: "2026-06-16 08:00:00",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40238/M",
      remark: "  volať pred doručením  ",
    });
    expect(mapped.record?.remark).toBe("volať pred doručením");
  });

  // issue 164: interná poznámka e-shopu (`shopRemark`, stĺpec 28) — NEZÁVISLÉ
  // pole od `remark` (zákaznícky odkaz) overeného vyššie. Fixtúra nesie order
  // 20300001 s hodnotou v tomto poli.
  it("shopRemark (interná poznámka e-shopu) sa načíta zo stĺpca 28", () => {
    const csv = parseShoptetOrdersCsv(FIXTURE);
    const rows = [...csv.rows()];
    const real = rows.find((r) => r["itemCode"] === "40237/XL" && r["itemAmount"] === "2");
    if (real === undefined) throw new Error("fixtúra nemá očakávaný riadok");
    const mapped = mapOrderRow(real);
    expect(mapped.record?.shopRemark).toBe("Zakaznik je stavebna firma, vybavit prednostne");
  });

  it("prázdny shopRemark sa mapuje na null, nikdy na prázdny reťazec", () => {
    const csv = parseShoptetOrdersCsv(FIXTURE);
    const rows = [...csv.rows()];
    const real = rows.find((r) => r["itemCode"] === "40238/M");
    if (real === undefined) throw new Error("fixtúra nemá očakávaný riadok");
    const mapped = mapOrderRow(real);
    expect(mapped.record?.shopRemark).toBeNull();
  });

  it("chýbajúci stĺpec shopRemark na riadku → null (nikdy nevyhodí)", () => {
    const mapped = mapOrderRow({
      code: "20300008",
      date: "2026-06-16 08:00:00",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40238/M",
    });
    expect(mapped.record?.shopRemark).toBeNull();
  });

  it("shopRemark s okolitými medzerami sa orezáva", () => {
    const mapped = mapOrderRow({
      code: "20300009",
      date: "2026-06-16 08:00:00",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40238/M",
      shopRemark: "  vybaviť prednostne  ",
    });
    expect(mapped.record?.shopRemark).toBe("vybaviť prednostne");
  });

  // issue 59: normalizácia (NFC + orez) musí bežať aj v `mapOrderRow`, nie
  // len v `normalizeStatusName` samostatne — inak by porovnanie s
  // `order_open_status` (nastavené presne cez rovnakú funkciu,
  // `open-statuses.ts`) mohlo zlyhať na medzere/inej Unicode forme.
  it("statusName sa normalizuje (orez medzier)", () => {
    const mapped = mapOrderRow({
      code: "20300004",
      date: "2026-06-16 08:00:00",
      statusName: "  Vybavuje sa  ",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40238/M",
    });
    expect(mapped.record?.statusName).toBe("Vybavuje sa");
  });

  it("chýbajúci stĺpec statusName na riadku → prázdny reťazec (nikdy nevyhodí)", () => {
    const mapped = mapOrderRow({
      code: "20300005",
      date: "2026-06-16 08:00:00",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40238/M",
    });
    expect(mapped.record?.statusName).toBe("");
  });

  it("customerName spadne na deliveryFullName, keď je billFullName prázdne", () => {
    const mapped = mapOrderRow({
      code: "20300002",
      date: "2026-06-16 08:00:00",
      billFullName: "",
      deliveryFullName: "Eva Malá",
      itemName: "Šiltovka FOREST",
      itemAmount: "1",
      itemCode: "40238/M",
    });
    expect(mapped.record?.customerName).toBe("Eva Malá");
  });

  it("customerName je zástupný text, keď sú OBE mená prázdne", () => {
    const mapped = mapOrderRow({
      code: "20300099",
      date: "2026-06-16 08:00:00",
      billFullName: "",
      deliveryFullName: "",
      itemName: "X",
      itemAmount: "1",
      itemCode: "40238/M",
    });
    expect(mapped.record?.customerName).toBe("(bez mena)");
  });
});

describe("mapOrderRow — preskočené riadky", () => {
  it("prázdny 'code' → empty_order_code, žiadny záznam", () => {
    const mapped = mapOrderRow({ code: "", date: "2026-01-01 00:00:00", itemAmount: "1", itemCode: "40237/XL" });
    expect(mapped.record).toBeNull();
    expect(mapped.issue?.kind).toBe("empty_order_code");
  });

  it("prázdny 'itemCode' → empty_item_code, žiadny záznam", () => {
    const mapped = mapOrderRow({ code: "20300003", date: "2026-01-01 00:00:00", itemAmount: "0", itemCode: "" });
    expect(mapped.record).toBeNull();
    expect(mapped.issue?.kind).toBe("empty_item_code");
  });

  it.each(["SHIPPING6", "shipping4", "BILLING10", "DISCOUNT", "GIFT1", "VOUCHER", "CERT3"])(
    "pseudo-položka '%s' (doprava/platba/zľava) → pseudo_item, žiadny záznam",
    (itemCode) => {
      const mapped = mapOrderRow({
        code: "20300001",
        date: "2026-06-15 10:30:00",
        itemAmount: "1",
        itemCode,
      });
      expect(mapped.record).toBeNull();
      expect(mapped.issue?.kind).toBe("pseudo_item");
    },
  );

  it("nekladné množstvo → invalid_quantity, žiadny záznam", () => {
    const mapped = mapOrderRow({ code: "20300003", date: "2026-01-01 00:00:00", itemAmount: "0", itemCode: "40239/S" });
    expect(mapped.record).toBeNull();
    expect(mapped.issue?.kind).toBe("invalid_quantity");
  });

  it("neceločíselné množstvo → invalid_quantity, žiadny záznam", () => {
    const mapped = mapOrderRow({ code: "20300003", date: "2026-01-01 00:00:00", itemAmount: "1,5", itemCode: "40239/S" });
    expect(mapped.record).toBeNull();
    expect(mapped.issue?.kind).toBe("invalid_quantity");
  });

  it("nerozpoznateľný formát dátumu → unparseable_date, žiadny záznam", () => {
    const mapped = mapOrderRow({ code: "20300003", date: "15.1.2026", itemAmount: "1", itemCode: "40239/S" });
    expect(mapped.record).toBeNull();
    expect(mapped.issue?.kind).toBe("unparseable_date");
  });
});

// Shoptet's `date` nenesie časovú zónu — je to miestny čas Europe/Bratislava.
// Tieto dva testy zámerne pokrývajú LETNÝ (CEST, UTC+2) aj ZIMNÝ (CET, UTC+1)
// dátum — pevný offset by jeden z nich vždy posunul o hodinu.
describe("parseShopLocalDateTime", () => {
  it("letný čas (CEST, UTC+2): 12:00 miestneho = 10:00 UTC", () => {
    const parsed = parseShopLocalDateTime("2026-07-15 12:00:00");
    expect(parsed?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("zimný čas (CET, UTC+1): 12:00 miestneho = 11:00 UTC", () => {
    const parsed = parseShopLocalDateTime("2026-01-15 12:00:00");
    expect(parsed?.toISOString()).toBe("2026-01-15T11:00:00.000Z");
  });

  it("vráti null pre nerozpoznateľný tvar", () => {
    expect(parseShopLocalDateTime("nie je dátum")).toBeNull();
    expect(parseShopLocalDateTime("2026-07-15")).toBeNull();
  });
});

// issue 59: rovnaká normalizácia ako stará appka's `norm_status`
// (`export_helpers.py`) — musí byť rovnaká na oboch stranách porovnania
// (export vs. `order_open_status`), inak sa zhoda nikdy nenájde.
describe("normalizeStatusName", () => {
  it("orezáva okolité medzery", () => {
    expect(normalizeStatusName("  Vybavuje sa  ")).toBe("Vybavuje sa");
  });

  it("NFC-normalizuje rozlozenu diakritiku na zlozenu formu", () => {
    // holé "a" + SAMOSTATNY kombinujuci accent (U+0301, NFD) vyzera
    // identicky ako zlozene "a s dlzňom" (NFC), je to vsak BAJTOVO INY retazec.
    const nfd = "Vybaven" + "á";
    expect(nfd).not.toBe("Vybavená");
    expect(normalizeStatusName(nfd)).toBe("Vybavená");
  });

  it("prázdny reťazec ostáva prázdny", () => {
    expect(normalizeStatusName("")).toBe("");
  });
});

describe("REQUIRED_ORDER_COLUMNS", () => {
  it("obsahuje statusName (issue 59) — bez neho appka nemá podľa čoho filtrovať 'Na objednanie'", () => {
    expect(REQUIRED_ORDER_COLUMNS).toContain("statusName");
  });
});

// issue 120: interné Shoptet id objednávky sa berie z XML exportu
// (`SHOPTET_ORDERS_XML_URL`), NIE z CSV (ktorý ho vôbec nenesie) — fixtúra
// nižšie je ručne vyrobená (2 objednávky), rovnaké skutočné hodnoty (id aj
// kód), aké boli naživo overené na produkcii 2026-07-31.
describe("extractOrderIdsFromXml", () => {
  it("vytiahne pár (kód, interné id) pre každú objednávku", () => {
    const map = extractOrderIdsFromXml(XML_FIXTURE);
    expect(map.get("20260897")).toBe(58656);
    expect(map.get("20261244")).toBe(58728);
    expect(map.size).toBe(2);
  });

  it("nezamení objednávkové ORDER_ID s kódom POLOŽKY vnútri ORDER_ITEMS", () => {
    const map = extractOrderIdsFromXml(XML_FIXTURE);
    // Položkové kódy (40304/L, SHIPPING11, 40259/L) sa nesmú objaviť ako kľúč.
    expect(map.has("40304/L")).toBe(false);
    expect(map.has("SHIPPING11")).toBe(false);
    expect(map.has("40259/L")).toBe(false);
  });

  it("prázdny XML vráti prázdnu mapu", () => {
    expect(extractOrderIdsFromXml("<ORDERS></ORDERS>").size).toBe(0);
  });
});

// issue 172: "Nevyzdvihnuté zásielky" potrebuje email/telefón/číslo zásielky
// (objednávkové polia) a meno dopravcu (LEN zo SHIPPING pseudo-riadku).
describe("extractOrderLevelExtra", () => {
  it("vytiahne email/phone/packageNumber z bežného produktového riadku", () => {
    const extra = extractOrderLevelExtra({
      code: "20300001",
      email: "jan@example.sk",
      phone: "+421900123456",
      packageNumber: "EF123456789SK",
      itemCode: "40237/XL",
      itemName: "Nohavice FOREST 1003",
    });
    expect(extra).toEqual({
      email: "jan@example.sk",
      phone: "+421900123456",
      packageNumber: "EF123456789SK",
      shippingCarrierName: null,
    });
  });

  it("vytiahne meno dopravcu LEN keď itemCode začína SHIPPING (case-insensitive)", () => {
    const extra = extractOrderLevelExtra({
      code: "20300001",
      itemCode: "shipping6",
      itemName: "Kuriér",
    });
    expect(extra.shippingCarrierName).toBe("Kuriér");
  });

  it("nezoberie itemName ako dopravcu pri BILLING/DISCOUNT pseudo-riadku", () => {
    expect(extractOrderLevelExtra({ itemCode: "BILLING2", itemName: "Dobierka" }).shippingCarrierName).toBeNull();
    expect(extractOrderLevelExtra({ itemCode: "DISCOUNT", itemName: "Zľava" }).shippingCarrierName).toBeNull();
  });

  it("prázdne/chýbajúce polia sa mapujú na null, nikdy na prázdny reťazec", () => {
    expect(extractOrderLevelExtra({})).toEqual(EMPTY_ORDER_LEVEL_EXTRA);
    expect(extractOrderLevelExtra({ email: "  ", phone: "" })).toEqual(EMPTY_ORDER_LEVEL_EXTRA);
  });
});

describe("mergeOrderLevelExtra", () => {
  it("PRVÁ neprázdna hodnota KAŽDÉHO poľa vyhráva nezávisle od ostatných polí", () => {
    const fromProductRow = extractOrderLevelExtra({
      email: "jan@example.sk",
      itemCode: "40237/XL",
      itemName: "Nohavice",
    });
    const fromShippingRow = extractOrderLevelExtra({
      packageNumber: "EF123456789SK",
      itemCode: "SHIPPING6",
      itemName: "Kuriér",
    });
    const merged = mergeOrderLevelExtra(mergeOrderLevelExtra(EMPTY_ORDER_LEVEL_EXTRA, fromProductRow), fromShippingRow);
    expect(merged).toEqual({
      email: "jan@example.sk",
      phone: null,
      packageNumber: "EF123456789SK",
      shippingCarrierName: "Kuriér",
    });
  });

  it("neskoršia hodnota NIKDY neprepíše už zistenú (prvá vyhráva, nie posledná)", () => {
    const first = extractOrderLevelExtra({ email: "prvy@example.sk" });
    const second = extractOrderLevelExtra({ email: "druhy@example.sk" });
    expect(mergeOrderLevelExtra(first, second).email).toBe("prvy@example.sk");
  });
});
