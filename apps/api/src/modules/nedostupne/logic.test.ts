import { describe, expect, it } from "vitest";
import { MAIL_TEMPLATE_KINDS } from "../mail-templates/registry.js";
import { buildAlternativeEmail, buildUnavailableEmail } from "./logic.js";

// issue 192: znenie žije v upraviteľnej šablóne — tieto testy overujú PÔVODNÉ
// znenie, teda presne to, čo appka použije, kým majiteľ nič nezmení.
const NEDOSTUPNE = MAIL_TEMPLATE_KINDS["nedostupne"].defaultText;
const ALTERNATIVA = MAIL_TEMPLATE_KINDS["nedostupne_alternativa"].defaultText;

describe("buildUnavailableEmail", () => {
  it("obsahuje pozdrav a majiteľov schválený generický text, bez konkrétneho produktu", () => {
    const built = buildUnavailableEmail(NEDOSTUPNE, "Ján Zákazník");
    expect(built.subject).toBe("Informácia o dostupnosti vašej objednávky — Forestshop.sk");
    expect(built.html).toContain("Ján Zákazník");
    expect(built.html).toContain("je momentálne");
    expect(built.text).toContain("Ján Zákazník");
    expect(built.html).toContain("Drlík, Forestshop.sk");
  });

  it("HTML-escapuje voľné meno zákazníka", () => {
    const built = buildUnavailableEmail(NEDOSTUPNE, '<script>alert("x")</script>');
    expect(built.html).not.toContain("<script>");
    expect(built.html).toContain("&lt;script&gt;");
  });

  it("prázdne meno padá späť na 'zákazník'", () => {
    const built = buildUnavailableEmail(NEDOSTUPNE, "");
    expect(built.html).toContain(">zákazník<");
  });
});

// issue 238: automatický návrh (`product.relatedCodes` → `buildAlternatives`)
// je preč — `buildAlternativeEmail` teraz dostáva PRIAMO majiteľove ručne
// vložené odkazy (holé URL, appka k nim nepozná žiadny názov/kód), preto sa
// v e-maile zobrazí samotný odkaz ako klikateľný text (`label === url`).
describe("buildAlternativeEmail", () => {
  it("s ručnými odkazmi vypíše KAŽDÝ z nich (label je samotná URL, appka nepozná názov)", () => {
    const built = buildAlternativeEmail(ALTERNATIVA, "Ján Zákazník", "Nohavice FOREST 1003", [
      "https://www.forestshop.sk/nahradny-produkt/",
    ]);
    expect(built.subject).toBe("Alternatívy k vášmu tovaru — Forestshop.sk");
    expect(built.html).toContain("Nohavice FOREST 1003");
    expect(built.html).toContain("https://www.forestshop.sk/nahradny-produkt/");
    expect(built.text).toContain("https://www.forestshop.sk/nahradny-produkt/");
  });

  it("viac odkazov naraz — každý dostane svoju položku v zozname", () => {
    const built = buildAlternativeEmail(ALTERNATIVA, "Ján", "Bunda", [
      "https://www.forestshop.sk/a/",
      "https://www.forestshop.sk/b/",
    ]);
    expect(built.html).toContain("https://www.forestshop.sk/a/");
    expect(built.html).toContain("https://www.forestshop.sk/b/");
  });

  it("bez odkazov ponúkne kontaktnú vetu namiesto zoznamu", () => {
    const built = buildAlternativeEmail(ALTERNATIVA, "Ján Zákazník", "Nohavice FOREST 1003", []);
    expect(built.html).toContain("Radi vám pomôžeme nájsť vhodnú alternatívu");
    expect(built.html).not.toContain("<ul>");
  });

  it("HTML-escapuje názov produktu (odkazy samotné sú vždy appkou vygenerované URL, nie voľný text)", () => {
    const built = buildAlternativeEmail(ALTERNATIVA, "Ján", "<i>Prod</i>", ["https://www.forestshop.sk/x/"]);
    expect(built.html).not.toContain("<i>Prod</i>");
    expect(built.html).toContain("&lt;i&gt;Prod&lt;/i&gt;");
  });
});
