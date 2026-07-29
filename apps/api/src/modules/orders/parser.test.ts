import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeCp1250,
  mapOrderRow,
  parseDelimited,
  parseShopLocalDateTime,
  parseShoptetOrdersCsv,
  REQUIRED_ORDER_COLUMNS,
} from "./parser.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/orders-sample.csv", import.meta.url)),
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
