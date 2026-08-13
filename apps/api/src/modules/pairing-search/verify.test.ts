import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SearchClient, type Fetcher } from "./client.js";
import type { PairingProduct } from "./types.js";
import { codeVerdict, extractPage, verifyCandidateCode } from "./verify.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
}

const WETLAND_DETAIL = fixture("wetland-detail-nohavice.html");
const BETALOV_DETAIL = fixture("betalov-detail-nohavice.html");
const ODIMON_DETAIL = fixture("odimon-detail-nohavice.html");

// Detailná URL potrebná pre `extractPage`'s `og:image` rezolúciu (issue
// 397) — žiadna z troch fixtúr vyššie `og:image` nenesie (živo overené
// `grep`om, `apps/api/src/modules/pairing-search/fixtures/`), takže
// `.image` na nich je vždy `null`; `og:image` správanie sa testuje
// samostatne nižšie na syntetickom HTML.
const DETAIL_URL = "https://www.wetland.sk/x";

function product(externalCodes: readonly string[], name = "Testovací produkt"): PairingProduct {
  return { productKey: "P1", name, supplier: "WETLAND", externalCodes };
}

describe("extractPage — kódová kaskáda (issue 387 E4, port verify.py's extract_page)", () => {
  it("WETLAND (PrestaShop): preskočí .detail__title 'Značka' a nájde .detail__title 'Kód' -> .detail__right", () => {
    const page = extractPage(WETLAND_DETAIL, DETAIL_URL);
    expect(page.code).toBe("3726-391-48@");
    expect(page.title).toBe("DEERHUNTER Pro Gamekeeper Boot Trousers - poľovnícke nohavice");
  });

  it("BETALOV (Nette): .fs-5 regex 'Katalógové číslo: X'", () => {
    const page = extractPage(BETALOV_DETAIL, DETAIL_URL);
    expect(page.code).toBe("OB3022");
    expect(page.title).toBe("Detské outdoorové nohavice - Combi");
  });

  it("ODIMON (BUXUS, odchýlka od doslovného portu): preskočí 'Kategória' a nájde .product-property-item s 'kód' v popisku", () => {
    const page = extractPage(ODIMON_DETAIL, DETAIL_URL);
    expect(page.code).toBe("PO22811");
    expect(page.title).toBe("Termoprádlo nohavice modal Termovel");
  });

  it("generický fallback (bez <h1>): itemprop=sku + title-tag so stripnutým '| Site' chvostom", () => {
    const html =
      '<html><head><title>Produkt XY | Forestshop</title></head><body>' +
      '<span itemprop="sku">ABC123</span></body></html>';
    const page = extractPage(html, DETAIL_URL);
    expect(page.title).toBe("Produkt XY");
    expect(page.code).toBe("ABC123");
  });

  it("title-tag so ' - ' oddeľovačom (bez '|') sa tiež strihá na prvú časť", () => {
    const html = "<html><head><title>Produkt XY - Forestshop</title></head><body></body></html>";
    expect(extractPage(html, DETAIL_URL).title).toBe("Produkt XY");
  });

  it("žiadny <h1> ani <title> -> prázdny title", () => {
    expect(extractPage("<html><head></head><body><p>nič</p></body></html>", DETAIL_URL).title).toBe("");
  });

  it("kód sa nikde na stránke nenašiel -> code je null", () => {
    const html = "<html><body><h1>Nejaký produkt</h1><p>bez akéhokoľvek kódu</p></body></html>";
    expect(extractPage(html, DETAIL_URL).code).toBeNull();
  });

  it(".detail__title bez slova 'kód' v texte (napr. len 'Značka') sa nikdy nepoužije ako zdroj kódu", () => {
    const html =
      '<html><body><h1>X</h1><ul><li class="detail">' +
      '<div class="detail__left"><span class="detail__title">Značka</span></div>' +
      '<div class="detail__right">DEERHUNTER</div></li></ul></body></html>';
    expect(extractPage(html, DETAIL_URL).code).toBeNull();
  });
});

describe("extractPage — og:image fallback (issue 397, mimo doslovného portu)", () => {
  it("prítomný og:image sa resolvuje na absolútnu URL", () => {
    const html = '<html><head><meta property="og:image" content="/img/produkt.jpg"></head><body></body></html>';
    expect(extractPage(html, "https://www.odimon.sk/x").image).toBe("https://www.odimon.sk/img/produkt.jpg");
  });

  it("absolútny og:image content ostáva nezmenený", () => {
    const html = '<html><head><meta property="og:image" content="https://www.odimon.sk/img/produkt.jpg"></head></html>';
    expect(extractPage(html, DETAIL_URL).image).toBe("https://www.odimon.sk/img/produkt.jpg");
  });

  it("žiadny og:image -> image je null", () => {
    expect(extractPage("<html><head></head><body></body></html>", DETAIL_URL).image).toBeNull();
  });

  it("šumový og:image (BETALOV's stránkové logo, živo overené 13. 8. 2026) sa filtruje na null", () => {
    const html = '<html><head><meta property="og:image" content="https://www.huntingshop.eu/assets2/front/svg/logo2.svg"></head></html>';
    expect(extractPage(html, "https://www.huntingshop.eu/x").image).toBeNull();
  });

  it("prázdny og:image content -> image je null", () => {
    const html = '<html><head><meta property="og:image" content=""></head></html>';
    expect(extractPage(html, DETAIL_URL).image).toBeNull();
  });
});

describe("codeVerdict — port verify.py's code_verdict (viac-kódová adaptácia)", () => {
  it("produkt bez external kódu je VŽDY unsure — nikdy false-ok", () => {
    const result = codeVerdict(product([]), { title: "čokoľvek", code: null, image: null });
    expect(result.verdict).toBe("unsure");
  });

  it("kód sa nachádza priamo v extrahovanom .code poli -> ok", () => {
    const result = codeVerdict(product(["OB570"]), { title: "HART RANDO XHP OB570", code: "OB570", image: null });
    expect(result.verdict).toBe("ok");
    expect(result.reason).toContain("OB570");
  });

  it("kód sa nenašiel na stránke -> unsure", () => {
    const result = codeVerdict(product(["OB570"]), { title: "Iný produkt", code: "ZZ9", image: null });
    expect(result.verdict).toBe("unsure");
  });

  it("regresia: kód '376' sa nezhoduje ako podreťazec '3760' (code_present hranica)", () => {
    const result = codeVerdict(product(["376"]), { title: "Lampáš model 3760", code: null, image: null });
    expect(result.verdict).toBe("unsure");
  });

  it("kód '376' sedí, keď je ohraničený (nie súčasť dlhšieho behu)", () => {
    const result = codeVerdict(product(["376"]), { title: "Lampáš model 376 LED", code: "376", image: null });
    expect(result.verdict).toBe("ok");
  });

  it("viac external kódov (adaptácia na per-variant kódy): zhoda platí, keď sedí HOCIKTORÝ z nich", () => {
    const result = codeVerdict(product(["NESEDI1", "SEDI2", "NESEDI3"]), { title: "Produkt SEDI2 model", code: null, image: null });
    expect(result.verdict).toBe("ok");
    expect(result.reason).toContain("SEDI2");
  });

  it("žiadny z viacerých kódov nesedí -> unsure, dôvod cituje všetky", () => {
    const result = codeVerdict(product(["A1", "B2"]), { title: "Nič také tu nie je", code: null, image: null });
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain("A1");
    expect(result.reason).toContain("B2");
  });

  it("issue 397: image z page sa NESIE do výsledku bez ohľadu na kódový verdikt", () => {
    const result = codeVerdict(product(["OB570"]), { title: "HART RANDO XHP OB570", code: "OB570", image: "https://x/img.jpg" });
    expect(result.imageUrl).toBe("https://x/img.jpg");
  });
});

describe("verifyCandidateCode — sieťový wrapper (SearchClient.fetchPage)", () => {
  it("produkt bez external kódu sa NIKDY nefetchuje (šetrí requesty) a vráti unsure, imageUrl null", async () => {
    let called = false;
    const fetcher: Fetcher = () => {
      called = true;
      return Promise.resolve(WETLAND_DETAIL);
    };
    const client = new SearchClient({ fetcher });
    const result = await verifyCandidateCode(client, "https://www.wetland.sk/x", product([]));
    expect(result.verdict).toBe("unsure");
    expect(result.imageUrl).toBeNull();
    expect(called).toBe(false);
  });

  it("úspešný fetch + zhodný kód -> ok", async () => {
    const fetcher: Fetcher = () => Promise.resolve(WETLAND_DETAIL);
    const client = new SearchClient({ fetcher });
    const result = await verifyCandidateCode(client, "https://www.wetland.sk/x", product(["3726-391-48@"]));
    expect(result.verdict).toBe("ok");
  });

  it("issue 397: úspešný fetch vráti imageUrl z og:image TEJ ISTEJ stránky (žiadny extra fetch)", async () => {
    const html = '<html><head><meta property="og:image" content="/img/x.jpg"></head><body><h1>H</h1></body></html>';
    const fetcher: Fetcher = () => Promise.resolve(html);
    const client = new SearchClient({ fetcher });
    const result = await verifyCandidateCode(client, "https://www.wetland.sk/produkt-x", product(["KOD1"]));
    expect(result.imageUrl).toBe("https://www.wetland.sk/img/x.jpg");
  });

  it("zlyhaný fetch (sieťová chyba) sa NIKDY nevyhodí ďalej -> unsure s dôvodom, imageUrl null", async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error("simulovaný sieťový pád"));
    const client = new SearchClient({ fetcher });
    const result = await verifyCandidateCode(client, "https://www.wetland.sk/x", product(["KOD1"]));
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain("simulovaný sieťový pád");
    expect(result.imageUrl).toBeNull();
  });
});
