// Nové domény (issue 332): appka mala 28 domén padajúcich na `unknown` (fail-
// closed od issue 330), z toho tieto tri majú spoľahlivo čitateľný viditeľný
// text — hunting24.cz/chocolenka.cz zdieľajú Shoptet šablónu s issue 227/307,
// vreckovynoz.sk je nová vlastná trieda. Vydelené do vlastného súboru (rovnaký
// dôvod ako parse-issue307.test.ts/parse-issue330.test.ts) — max-lines: 400.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { textAvailabilityRuleFor } from "./availability-domain-rules.js";
import { parsePage } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const HUNTING24_SKLADEM = fixture("hunting24-skladem-pantera.html");
const CHOCOLENKA_SKLADEM_TOOLTIP = fixture("chocolenka-skladem-vnoreny-tooltip.html");
const CHOCOLENKA_TOOLTIP_KOLIZNE_SLOVO = fixture("chocolenka-tooltip-kolizne-slovo.html");
const VRECKOVYNOZ_SKLADOM = fixture("vreckovynoz-skladom-ocielka.html");
const VRECKOVYNOZ_VYPREDANE_ENTITA = fixture("vreckovynoz-vypredane-entita.html");

describe("parsePage — issue 332: hunting24.cz/chocolenka.cz zdielaju Shoptet sablonu s issue 227/307", () => {
  it("hunting24.cz jednovelkostny produkt 'Skladem' je available", () => {
    const result = parsePage(HUNTING24_SKLADEM, "https://www.hunting24.cz/pantera-256-mini/");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("chocolenka.cz s VNORENYM tooltip <span title> vnutri labelAvailability sa cita ako cisty 'Skladem', nikdy s nezosmiznutym HTML fragmentom", () => {
    const result = parsePage(
      CHOCOLENKA_SKLADEM_TOOLTIP,
      "https://www.chocolenka.cz/sk/cokoladove-sady/cokoladova-sada-rybar/",
    );
    expect(result.availability).toBe("available");
    expect(result.availabilityText).toBe("skladem");
    expect(result.source).toBe("text");
  });

  it("regresny test (code review issue 332): extrahovana oblast je PRESNE 'Skladem', ziadny nezosmiznuty HTML/title fragment vnoreneho tooltipu", () => {
    // Priamy test extraktora (nie len parsePage vysledku) — bez title=/alt=
    // stripu pred fixom by tu bol garbled retazec s HTML tagom aj celou
    // title= hodnotou, nie cisty text. Rovnost (nie len .includes) je presne
    // to, co by pred-fix kod nesplnil.
    const rule = textAvailabilityRuleFor("https://www.chocolenka.cz/sk/cokoladove-sady/cokoladova-sada-rybar/");
    expect(rule).not.toBeNull();
    const region = rule?.extractRegion(CHOCOLENKA_SKLADEM_TOOLTIP, "https://www.chocolenka.cz/sk/x") ?? null;
    expect(region).toBe("Skladem");
  });

  it("regresny test (code review issue 332): kolizne OUT_KEYWORDS slovo VNUTRI tooltip title= sa nesmie dostat do vysledneho textu a nesmie sklopit dostupny produkt na 'unavailable'", () => {
    // Bez title=/alt= stripu by garbled text niesol aj "nedostupny" z
    // title= hodnoty tooltipu (dopravna poznamka, nic spolocne so skladovou
    // dostupnostou) — OUT_KEYWORDS vyhrava nad IN_KEYWORDS
    // (availabilityFromText), takze pred-fix kod by tu vratil `unavailable`
    // namiesto spravneho `available`.
    const result = parsePage(
      CHOCOLENKA_TOOLTIP_KOLIZNE_SLOVO,
      "https://www.chocolenka.cz/sk/testovaci-produkt-s-koliznym-tooltipom/",
    );
    expect(result.availability).toBe("available");
    expect(result.availabilityText).toBe("skladem");
  });
});

describe("parsePage — issue 332: vreckovynoz.sk product-detail__availability (bez uvodzoviek), odlisne od karuselovej product-card__stock", () => {
  it("'Skladom > 5 ks' hlavneho produktu je available, karta suvisiaceho produktu sa neberie", () => {
    const result = parsePage(
      VRECKOVYNOZ_SKLADOM,
      "https://vreckovynoz.sk/produkty/kuchynske-noze/ocielky-brusenie/victorinox-7-8330-ocielka",
    );
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("regresny test (mechanizmus): entitovo kodovana diakritika 'Vypredan&#xE9;' sa DEKODUJE, nikdy len nevyprazdni", () => {
    const result = parsePage(VRECKOVYNOZ_VYPREDANE_ENTITA, "https://vreckovynoz.sk/produkty/testovaci-produkt");
    expect(result.availability).toBe("unavailable");
  });
});
