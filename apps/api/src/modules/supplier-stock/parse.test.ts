import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  availabilityFromSchemaToken,
  availabilityFromText,
  fromJsonLd,
  fromMetaTags,
  hostOf,
  isTrustedTextHost,
  matchSizeLabel,
  parsePage,
  parsePrice,
  parseSizeAvailability,
  visibleText,
} from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const HUNTINGSHOP_VYPREDANY = fixture("huntingshop-vypredany-ruksak.html");
const HUNTINGSHOP_SKLADOM = fixture("huntingshop-skladom-tricko.html");
const ODIMON_NEDOSTUPNA = fixture("odimon-nedostupna-strelecka-palica.html");
const LASTING_BONY = fixture("lasting-bony-cepica-l-xl.html");
const LASTING_HILA = fixture("lasting-hila-tricko-bez-xs.html");
const TRIGONA_SKLADOM = fixture("trigona-skladom-10x42-sahara.html");
const TRIGONA_VYPREDANE = fixture("trigona-vypredane-8x56-ed-savannah.html");
const VIRGINIASHOP_SKLADOM = fixture("virginiashop-skladom-noz.html");
const VIRGINIASHOP_NEDOSTUPNE = fixture("virginiashop-nedostupne-puzdro.html");
const VIRGINIASHOP_VIACVARIANTOVY = fixture("virginiashop-viacvariantovy-bez-testid.html");
const TENOLIX_SKLADEM = fixture("tenolix-skladem-alpex.html");
const TENOLIX_NEDOSTUPNE = fixture("tenolix-nedostupne-falcon.html");
const LUKO_SKLADEM = fixture("luko-skladem-halenka.html");
const LUKO_VIACVELKOSTNA = fixture("luko-viacvelkostna-bez-testid.html");
const FOMEI_SKLADOM = fixture("fomei-skladom-puskohlad.html");
const FOMEI_NA_DOTAZ = fixture("fomei-nadotaz-dalekohlad.html");
const CHIRUCA_VELKOSTI = fixture("chiruca-velkosti-cameros.html");

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

  it("volny text sa pouzije LEN na overenej domene, a LEN na vyrezanej oblasti produktu", () => {
    // Domena bez pravidla na vyrez (issue 223): text sa vobec necita, ostava unknown.
    const html = "<html><body><h1>Bunda</h1><p>Skladom</p></body></html>";
    expect(parsePage(html, "https://dogtrace.com/p/1")).toMatchObject({
      availability: "unknown",
      source: "none",
    });
  });

  it("necitatelna stranka na domene BEZ pravidla je unknown, nikdy dohad", () => {
    const result = parsePage("<html><body>Popis produktu</body></html>", "https://dogtrace.com/p/1");
    expect(result).toEqual({ availability: "unknown", availabilityText: "", price: null, source: "none" });
  });
});

describe("parsePage — issue 223: huntingshop.eu cita LEN stitok pri produkte", () => {
  it("vypredany produkt (ziadny detailny stitok, len paticka a karusel) je unavailable", () => {
    const result = parsePage(HUNTINGSHOP_VYPREDANY, "https://www.huntingshop.eu/hart-spean-25-ruksak-8060");
    expect(result.availability).toBe("unavailable");
  });

  it("skladom produkt (skutocny detailny stitok badge-outline- bez badge-stock) je available", () => {
    const result = parsePage(HUNTINGSHOP_SKLADOM, "https://www.huntingshop.eu/aktiva-z-green-funkcne-tricko");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
    expect(result.availabilityText.toLowerCase()).toContain("skladom");
  });

  it("paticková veta SAMA O SEBE (bez detailneho stitku) nesmie stacit na available", () => {
    // Rovnaka paticka ako v skladom-fixture, ale ako VLASTNA, izolovana stranka
    // bez ziadneho badge-outline- stitku — presne situacia, ktora bola zdrojom
    // falosneho pozitiva pred opravou (celostrankovy volny text).
    const html = `<html><body><footer>
      <h2 class="title h6">Skladová dostupnosť</h2>
      <p class="fs-6 mb-0">Viac ako 90% ponúkaných produktov máme skladom ihneď k odberu.</p>
    </footer></body></html>`;
    const result = parsePage(html, "https://www.huntingshop.eu/nejaky-produkt");
    expect(result.availability).not.toBe("available");
  });
});

describe("parsePage — issue 225: odimon.sk — viditelna dostupnost prebija klamlive JSON-LD", () => {
  it("rozpor JSON-LD (InStock) vs viditelne 'Nedostupny' pri produkte je unknown, nikdy available", () => {
    const result = parsePage(
      ODIMON_NEDOSTUPNA,
      "https://www.odimon.sk/polovnicke-potreby/doplnky-na-lov/nastavitelna-strelecka-palica-odimon-primo-tetrao-gen.ii-4-noha",
    );
    expect(result.availability).toBe("unknown");
    expect(result.availability).not.toBe("available");
  });

  it("zhoda JSON-LD a viditelnej dostupnosti sa pouzije (viditelna je zdroj textu)", () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","offers":{"@type":"Offer","availability":"OutOfStock"}}
    </script></head><body>
      <span class="product-availability__value product-availability__value--unavailable">
        <span class="product-availability__value--text">Nedostupný</span>
      </span>
    </body></html>`;
    const result = parsePage(html, "https://www.odimon.sk/p/nieco");
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("text");
  });

  it("text sa cita EXPLICITNE z vnoreneho --text prvku, aj ked ten ma dalsi vnoreny prvok (pocet kusov)", () => {
    // Presne markup suvisiaceho produktu z ODIMON_NEDOSTUPNA fixtury: --text
    // prvok ma VNORENY <span class="...__count">, takze naivne "druha
    // zatvaracia znacka" by odrezala/posunula text. Token (available/
    // unavailable) sa berie z vonkajsej triedy nezavisle od tohto vnorenia.
    const html = `<span class="product-availability__value product-availability__value--available">
      <span class="product-availability__value--text">
        <strong>Skladom</strong>
        <span class="product-availability__count">9 ks</span>
      </span>
    </span>`;
    const result = parsePage(html, "https://www.odimon.sk/p/ine");
    expect(result.availability).toBe("available");
    expect(result.availabilityText).toBe("Skladom 9 ks");
  });
});

describe("parsePage — issue 230: trigona.sk cita farebny StockCountText stitok pri produkte", () => {
  it("doverovana je trigona.sk aj jej poddomena, ale nie cudzia domena s rovnakym koncom", () => {
    expect(isTrustedTextHost("https://www.trigona.sk/eshop/p-1/nieco.xhtml")).toBe(true);
    expect(isTrustedTextHost("https://trigona.sk/eshop/p-1/nieco.xhtml")).toBe(true);
    expect(isTrustedTextHost("https://nottrigona.sk/eshop/p-1/nieco.xhtml")).toBe(false);
  });

  it("zelena farba (#00b020, 'Na sklade') je available — zodpoveda JSON-LD InStock na tom istom produkte", () => {
    const result = parsePage(TRIGONA_SKLADOM, "https://www.trigona.sk/eshop/10x42-sahara/p-1217729.xhtml");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("modra farba (#024bbd, '1 - 4 tyzdne') je unavailable — zodpoveda JSON-LD OutOfStock na tom istom produkte", () => {
    const result = parsePage(TRIGONA_VYPREDANE, "https://www.trigona.sk/eshop/8x56-ed-savannah/p-1215478.xhtml");
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("text");
  });

  it("chybajuci alebo neznamy stitok je unknown, nikdy dohad — na rozdiel od huntingshop.eu tu nie je overene ziadne 'chyba = vypredane'", () => {
    const html = "<html><body><h1>Nejaky produkt</h1><p>Popis produktu.</p></body></html>";
    const result = parsePage(html, "https://www.trigona.sk/eshop/nieco/p-999.xhtml");
    expect(result.availability).toBe("unknown");
  });

  it("nerozpoznana farba stitku je tiez unknown, nikdy sa nehada podla textu delivery lehoty", () => {
    const html =
      '<span id="StockCountText42"><span style="color: #ff9900">Na dopyt</span></span>';
    const result = parsePage(html, "https://www.trigona.sk/eshop/nieco/p-42.xhtml");
    expect(result.availability).toBe("unknown");
  });
});

describe("parsePage — issue 227: virginiashop.sk/tenolix.cz/luko.cz zdieľaná Shoptet šablóna (data-testid=labelAvailability)", () => {
  it("virginiashop.sk skladom je available (zelena farba, text 'Skladom')", () => {
    const result = parsePage(VIRGINIASHOP_SKLADOM, "https://www.virginiashop.sk/polovnicke-noze/polovnicky-noz-kandar-motiv-diviak-23-11cm-puzdro/");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("virginiashop.sk 'Momentálne nedostupné' (cervena farba) je unavailable", () => {
    const result = parsePage(
      VIRGINIASHOP_NEDOSTUPNE,
      "https://www.virginiashop.sk/penazenky-a-dokladovky/kozene-puzdro-na-plovnicke--doklady-motiv-jelen-sv--hubert/",
    );
    expect(result.availability).toBe("unavailable");
  });

  it("viacvariantovy produkt (bez data-testid) je unknown, nikdy dohad z niektorej z viacerych zhod", () => {
    const result = parsePage(
      VIRGINIASHOP_VIACVARIANTOVY,
      "https://www.virginiashop.sk/ploskacky-s-poharikmi/ploskacka-4-pohariky-v-darcekovej-kazete-s-polovnickym-motivom-jelen-fj6-2/",
    );
    expect(result.availability).toBe("unknown");
  });

  it("tenolix.cz 'Skladem' (cesky tvar) je available", () => {
    const result = parsePage(TENOLIX_SKLADEM, "https://www.tenolix.cz/nocni-videni/hikmicro-alpex-4k-lrf-a50el/");
    expect(result.availability).toBe("available");
  });

  it("tenolix.cz 'Momentálně nedostupné' (mäkké č.ě, nie slovenské 'momentálne') je unavailable", () => {
    const result = parsePage(TENOLIX_NEDOSTUPNE, "https://www.tenolix.cz/termovize/hikmicro-falcon-fq25/");
    expect(result.availability).toBe("unavailable");
  });

  it("luko.cz jednoveľkostny produkt 'Skladem' je available", () => {
    const result = parsePage(
      LUKO_SKLADEM,
      "https://www.luko.cz/halenky-s-dlouhym-rukavem/damska-halenka-s-dlouhym-rukavem-model-162214/",
    );
    expect(result.availability).toBe("available");
  });

  it("luko.cz viacveľkostny produkt (bez data-testid, beznejsi pripad) je unknown, nikdy dohad", () => {
    const result = parsePage(
      LUKO_VIACVELKOSTNA,
      "https://www.luko.cz/myslivecke-a-outdoorove-kosile/bila-kosile--s-vysivkou-model-182115/",
    );
    expect(result.availability).toBe("unknown");
  });
});

describe("parsePage — issue 227: fomei.com — mikrodata triedy PRED nadpisom 'Súvisiace', nikdy z karuselu", () => {
  it("hlavny produkt 'availability--inStock' je available, aj ked karusel nizsie na stranke ma 'noStock'", () => {
    const result = parsePage(
      FOMEI_SKLADOM,
      "https://www.fomei.com/sk/produkty-fomei-1-7-10x42-foreman-htc-pro-g4-puskohlad-detail-277806",
    );
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("hlavny produkt 'availability--noStock' ('na dotaz') je unavailable", () => {
    const result = parsePage(
      FOMEI_NA_DOTAZ,
      "https://www.fomei.com/sk/produkty-fomei-10x52-foreman-pro-xld-dalekohlad-detail-249108",
    );
    expect(result.availability).toBe("unavailable");
  });
});

describe("parseSizeAvailability — issue 227: chiruca.sk zoznam veľkostí v <select>", () => {
  it("precita KAZDU velkost z <option> textu, nikdy stranku ako celok", () => {
    const sizes = parseSizeAvailability(CHIRUCA_VELKOSTI, "https://www.chiruca.sk/cameros/");
    expect(sizes).toEqual([
      { sizeLabel: "38", availability: "unavailable" },
      { sizeLabel: "40", availability: "available" },
      { sizeLabel: "42", availability: "unavailable" },
    ]);
  });

  it("stranka bez pravidla (ina domena) vracia null", () => {
    expect(parseSizeAvailability(CHIRUCA_VELKOSTI, "https://www.huntingshop.eu/p/1")).toBeNull();
  });
});

describe("parseSizeAvailability — issue 224: shop.lasting.eu zoznam veľkostí", () => {
  it("precita KAZDU velkost so svojou vlastnou dostupnostou, nikdy stranku ako celok", () => {
    const sizes = parseSizeAvailability(
      LASTING_BONY,
      "https://shop.lasting.eu/cs/cepice/19937-59938-lasting-merino-cepice-bony-cerna-8595067820460.html",
    );
    expect(sizes).toEqual([
      { sizeLabel: "S/M", availability: "available" },
      { sizeLabel: "L/XL", availability: "unavailable" },
    ]);
  });

  it("stranka bez zoznamu velkosti (ina domena) vracia null, nikdy prazdne pole", () => {
    expect(parseSizeAvailability(LASTING_BONY, "https://www.huntingshop.eu/p/1")).toBeNull();
  });

  it("poddomena patri pod to iste pravidlo ako holy host", () => {
    const sizes = parseSizeAvailability(LASTING_HILA, "https://sub.shop.lasting.eu/cs/nieco.html");
    expect(sizes).not.toBeNull();
  });
});

describe("matchSizeLabel — issue 224: parovanie NASHO size_label na dodavatela", () => {
  it("presna zhoda po odstraneni oddelovacov", () => {
    expect(matchSizeLabel("S-M", ["S/M", "L/XL"])).toBe("S/M");
  });

  it("tolerantne na skratenie POSLEDNEJ casti — nas 'L-X' je dodavatelovo 'L/XL'", () => {
    expect(matchSizeLabel("L-X", ["S/M", "L/XL"])).toBe("L/XL");
  });

  it("velkost, ktoru dodavatel vobec nema, sa nesparuje", () => {
    expect(matchSizeLabel("XS", ["S", "M", "L", "XL"])).toBeNull();
  });

  it("rozny pocet casti sa nikdy nepovazuje za zhodu", () => {
    expect(matchSizeLabel("L-X", ["XL"])).toBeNull();
  });

  it("viacnasobna zhoda je nejednoznacna — nikdy sa neuhadne", () => {
    expect(matchSizeLabel("X", ["XS", "XL"])).toBeNull();
  });
});
