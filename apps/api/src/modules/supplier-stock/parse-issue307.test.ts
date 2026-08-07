// Vydelené z parse.test.ts (issue 307), aby ani jeden zo súborov neprerástol
// eslint max-lines: 400 (`.claude/rules/testing.md`) — rovnaký vzor ako
// existujúci orders-http.integration.test.ts /
// orders-http-state.integration.test.ts split. Domény zubicek.cz/lesona.sk/
// rappa.cz/rosler.sk, ktoré predtým skončili vždy na `unknown`, pretože v
// `TEXT_AVAILABILITY_RULES`/`VISIBLE_AVAILABILITY_RULES` vôbec neboli.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePage } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const ZUBICEK_SKLADEM = fixture("zubicek-skladem-borlice.html");
const ZUBICEK_VIACVARIANTOVY = fixture("zubicek-viacvariantovy-bez-testid.html");
const LESONA_SKLADOM = fixture("lesona-skladom-nakrcnik.html");
const LESONA_VYPREDANE = fixture("lesona-vypredane-sluchadla.html");
const LESONA_POSLEDNE_KUSY = fixture("lesona-posledne-kusy-siltovka.html");
const RAPPA_SKLADOM = fixture("rappa-skladom-plysovy-pes.html");
const RAPPA_VYPREDANE = fixture("rappa-vypredane-plysova-ovce.html");
const ROSLER_SKLADOM = fixture("rosler-skladom-bruska.html");
const ROSLER_DO_14_DNI = fixture("rosler-do-14-dni-noz.html");
const ROSLER_VYPREDANE_ENTITA = fixture("rosler-vypredane-noz-entita.html");

describe("parsePage — issue 307: zubicek.cz zdiela byte-zhodnu Shoptet sablonu s issue 227", () => {
  it("jednovelkostny produkt 'Skladem' je available", () => {
    const result = parsePage(ZUBICEK_SKLADEM, "https://www.zubicek.cz/borlice--parohove-bolo/");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("viacvariantovy produkt (bez data-testid) je unknown, nikdy dohad", () => {
    const result = parsePage(ZUBICEK_VIACVARIANTOVY, "https://www.zubicek.cz/kozeny-opasek-sire-4-cm/");
    expect(result.availability).toBe("unknown");
  });
});

describe("parsePage — issue 307: lesona.sk mikrodata vedia klamat, cita sa viditelny <span id=product-availability>", () => {
  it("prazdny span (ziadna ikonka) je available", () => {
    const result = parsePage(
      LESONA_SKLADOM,
      "https://lesona.sk/doplnky-k-obleceniu/112-304-nakrcnik-alaska-1795-blindtech-invisible.html",
    );
    expect(result.availability).toBe("available");
  });

  it("ikonka product-unavailable + 'Vypredane' je unavailable (stránkové mikrodáta v tomto fixture sa vôbec neparsujú, takže nemôžu prekabátiť)", () => {
    const result = parsePage(
      LESONA_VYPREDANE,
      "https://lesona.sk/vybavenie/58-344-sluchadla-3m-peltor-sporttac.html",
    );
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("text");
  });

  it("ikonka product-last-items + 'Posledne kusy v sklade' je available (uz v IN_KEYWORDS)", () => {
    const result = parsePage(
      LESONA_POSLEDNE_KUSY,
      "https://lesona.sk/oblecenie-a-obuv/50-337-siltovka-alaska-1795-blindmax-hd.html",
    );
    expect(result.availability).toBe("available");
  });
});

describe("parsePage — issue 307: rappa.cz Dostupnost dt/dd, rozhoduje trieda in-stock/out-of-stock", () => {
  it("trieda 'in-stock' je available", () => {
    const result = parsePage(RAPPA_SKLADOM, "https://www.rappa.cz/sk/plysovy-pes-salasnik-lezici-23-cm.html");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("trieda 'out-of-stock' je unavailable", () => {
    const result = parsePage(RAPPA_VYPREDANE, "https://www.rappa.cz/sk/plysova-ovce-18-cm-eco-friendly-1.html");
    expect(result.availability).toBe("unavailable");
  });
});

describe("parsePage — issue 307: rosler.sk product-detail-stock div (odlisna trieda od karuselu product-thumb-stock)", () => {
  it("'Skladom > 5 ks' je available", () => {
    const result = parsePage(
      ROSLER_SKLADOM,
      "https://www.rosler.sk/produkty/kuchynske-noze-a-noziarske-vyrobky/ocielky-a-brusky/victorinox-bruska-na-noze-mala",
    );
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("'Do 14 dni' (dodanie na objednavku, naziva sa genuinny vypredany text nenasiel) je unknown, nikdy dohad", () => {
    const result = parsePage(
      ROSLER_DO_14_DNI,
      "https://www.rosler.sk/produkty/vreckove-noze/delemont/130mm/victorinox-rangergrip-57-hunter",
    );
    expect(result.availability).toBe("unknown");
  });

  it("regresny test (code review): entitovo kodovana diakritika 'Vypredan&#xE9;' sa DEKODUJE, nikdy len nevyprazdni", () => {
    const result = parsePage(ROSLER_VYPREDANE_ENTITA, "https://www.rosler.sk/produkty/testovaci-produkt");
    expect(result.availability).toBe("unavailable");
  });
});
