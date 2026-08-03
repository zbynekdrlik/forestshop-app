import { describe, expect, it } from "vitest";
import {
  availabilityFromSchemaToken,
  availabilityFromText,
  fromJsonLd,
  fromMetaTags,
  hostOf,
  isTrustedTextHost,
  parsePage,
  parsePrice,
  visibleText,
} from "./parse.js";

describe("hostOf / isTrustedTextHost", () => {
  it("odreze www a zmensi pismena", () => {
    expect(hostOf("https://WWW.HuntingShop.eu/produkt/1")).toBe("huntingshop.eu");
  });

  it("neplatna URL nie je host ani doverovana domena", () => {
    expect(hostOf("toto nie je url")).toBe("");
    expect(isTrustedTextHost("toto nie je url")).toBe(false);
  });

  it("doverovana je aj poddomena, ale nie cudzia domena s rovnakym koncom", () => {
    expect(isTrustedTextHost("https://shop.huntingshop.eu/a")).toBe(true);
    expect(isTrustedTextHost("https://nothuntingshop.eu/a")).toBe(false);
    expect(isTrustedTextHost("https://dogtrace.com/a")).toBe(false);
  });
});

describe("availabilityFromSchemaToken", () => {
  it("InStock a spol. su dostupne", () => {
    expect(availabilityFromSchemaToken("https://schema.org/InStock")).toBe("available");
    expect(availabilityFromSchemaToken("LimitedAvailability")).toBe("available");
  });

  it("OutOfStock a spol. su nedostupne", () => {
    expect(availabilityFromSchemaToken("http://schema.org/OutOfStock")).toBe("unavailable");
    expect(availabilityFromSchemaToken("SoldOut")).toBe("unavailable");
  });

  it("predobjednavka NIE je dostupnost — dodavatel to este nema", () => {
    expect(availabilityFromSchemaToken("https://schema.org/PreOrder")).toBe("unavailable");
    expect(availabilityFromSchemaToken("BackOrder")).toBe("unavailable");
  });

  it("neznamy alebo prazdny token je unknown", () => {
    expect(availabilityFromSchemaToken("https://schema.org/Nieco")).toBe("unknown");
    expect(availabilityFromSchemaToken("")).toBe("unknown");
  });
});

describe("availabilityFromText", () => {
  it("vypredane vyhrava nad skladom aj ked je skladom v texte skor", () => {
    const result = availabilityFromText("Skladom u nas, ale tento kus je Vypredané");
    expect(result.availability).toBe("unavailable");
    expect(result.matched).toBe("vypredané");
  });

  it("rozpozna skladom bez diakritiky aj cesky tvar", () => {
    expect(availabilityFromText("SKLADEM").availability).toBe("available");
    expect(availabilityFromText("posledne kusy").availability).toBe("available");
  });

  it("text bez signalu je unknown", () => {
    expect(availabilityFromText("Popis produktu, farba zelena").availability).toBe("unknown");
  });
});

describe("parsePrice", () => {
  it("zvlada obe oddelovacie znamienka — desatinne je to posledne", () => {
    expect(parsePrice("1 299,00 €")).toBe(1299);
    expect(parsePrice("1.299,00")).toBe(1299);
    expect(parsePrice("1,299.00")).toBe(1299);
  });

  it("zvlada cislo, ciarku aj bodku", () => {
    expect(parsePrice(59.9)).toBe(59.9);
    expect(parsePrice("59,90")).toBe(59.9);
    expect(parsePrice("59.90")).toBe(59.9);
  });

  it("nezmyselny vstup je null, nikdy 0", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("na dotaz")).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(Number.NaN)).toBeNull();
  });
});

describe("visibleText", () => {
  it("zahodi script a style, nie viditelny text", () => {
    const html = `<div>Skladom<script>var x = "Vypredané";</script><style>.a{}</style></div>`;
    expect(visibleText(html)).toBe("Skladom");
  });
});

const JSON_LD_PAGE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Bunda",
 "offers":{"@type":"Offer","price":"129,90","priceCurrency":"EUR",
 "availability":"https://schema.org/InStock"}}
</script>
</head><body>Vypredané</body></html>`;

describe("fromJsonLd", () => {
  it("precita dostupnost aj cenu z ponuky", () => {
    const hit = fromJsonLd(JSON_LD_PAGE);
    expect(hit?.availability).toBe("available");
    expect(hit?.price).toBe(129.9);
  });

  it("najde ponuku aj vnorenu v poli @graph", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebPage"},{"@type":"Product","offers":[
        {"@type":"Offer","availability":"OutOfStock","price":"10"}]}]}
    </script>`;
    expect(fromJsonLd(html)?.availability).toBe("unavailable");
  });

  it("nevalidny JSON-LD nezhodi citanie, len sa preskoci", () => {
    const html = `<script type="application/ld+json">{toto nie je JSON</script>`;
    expect(fromJsonLd(html)).toBeNull();
  });

  it("ponuka bez pouzitelnej dostupnosti nie je zhoda", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/Nieco"}}
    </script>`;
    expect(fromJsonLd(html)).toBeNull();
  });
});

describe("fromMetaTags", () => {
  it("precita product:availability aj cenu", () => {
    const html = `<meta property="product:availability" content="instock">
                  <meta property="product:price:amount" content="49.50">`;
    const hit = fromMetaTags(html);
    expect(hit?.availability).toBe("available");
    expect(hit?.price).toBe(49.5);
  });

  it("zvlada opacne poradie atributov", () => {
    const html = `<meta content="outofstock" name="og:availability">`;
    expect(fromMetaTags(html)?.availability).toBe("unavailable");
  });

  it("nezrozumitelny token v prvej znacke neukonci citanie — skusi sa dalsia", () => {
    const html = `<meta property="product:availability" content="skladom-hned">
                  <meta property="og:availability" content="outofstock">`;
    expect(fromMetaTags(html)?.availability).toBe("unavailable");
  });

  it("bez znaciek nic nevrati", () => {
    expect(fromMetaTags("<html><body>Skladom</body></html>")).toBeNull();
  });
});

describe("parsePage — poradie urovni", () => {
  it("JSON-LD prebija text stranky", () => {
    const result = parsePage(JSON_LD_PAGE, "https://huntingshop.eu/p/1");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("json_ld");
  });

  it("meta znacky sa pouziju, ked JSON-LD chyba", () => {
    const html = `<meta property="product:availability" content="outofstock"><body>Skladom</body>`;
    const result = parsePage(html, "https://huntingshop.eu/p/1");
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("meta");
  });

  it("volny text sa pouzije LEN na overenej domene", () => {
    const html = "<html><body><h1>Bunda</h1><p>Skladom</p></body></html>";
    expect(parsePage(html, "https://huntingshop.eu/p/1")).toMatchObject({
      availability: "available",
      source: "text",
    });
    expect(parsePage(html, "https://dogtrace.com/p/1")).toMatchObject({
      availability: "unknown",
      source: "none",
    });
  });

  it("necitatelna stranka je unknown, nikdy dohad", () => {
    const result = parsePage("<html><body>Popis produktu</body></html>", "https://huntingshop.eu/p/1");
    expect(result).toEqual({ availability: "unknown", availabilityText: "", price: null, source: "none" });
  });
});
