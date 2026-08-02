import { describe, expect, it } from "vitest";
import { alternativeSearchUrl } from "./constants.js";
import { buildAlternativeEmail, buildAlternatives, buildUnavailableEmail } from "./logic.js";

describe("buildUnavailableEmail", () => {
  it("obsahuje pozdrav a majiteľov schválený generický text, bez konkrétneho produktu", () => {
    const built = buildUnavailableEmail("Ján Zákazník");
    expect(built.subject).toBe("Informácia o dostupnosti vašej objednávky — Forestshop.sk");
    expect(built.html).toContain("Ján Zákazník");
    expect(built.html).toContain("je momentálne");
    expect(built.text).toContain("Ján Zákazník");
    expect(built.html).toContain("Drlík, Forestshop.sk");
  });

  it("HTML-escapuje voľné meno zákazníka", () => {
    const built = buildUnavailableEmail('<script>alert("x")</script>');
    expect(built.html).not.toContain("<script>");
    expect(built.html).toContain("&lt;script&gt;");
  });

  it("prázdne meno padá späť na 'zákazník'", () => {
    const built = buildUnavailableEmail("");
    expect(built.html).toContain(">zákazník<");
  });
});

describe("buildAlternatives", () => {
  it("neznámy kód padá späť na SEBA SAMÉHO ako meno (nikdy sa nezahodí)", () => {
    const alts = buildAlternatives(["60297"], new Map());
    expect(alts).toEqual([{ code: "60297", name: "60297", url: alternativeSearchUrl("60297") }]);
  });

  it("známy kód dostane rozlíšené meno z mapy", () => {
    const alts = buildAlternatives(["60116/90"], new Map([["60116/90", "Podkolienky BOBR"]]));
    expect(alts).toEqual([{ code: "60116/90", name: "Podkolienky BOBR", url: alternativeSearchUrl("60116/90") }]);
  });

  it("prázdny zoznam kódov → prázdny zoznam alternatív", () => {
    expect(buildAlternatives([], new Map())).toEqual([]);
  });
});

describe("buildAlternativeEmail", () => {
  it("s alternatívami vypíše odkazy na KAŽDÚ z nich", () => {
    const alts = buildAlternatives(["60116/90"], new Map([["60116/90", "Podkolienky BOBR"]]));
    const built = buildAlternativeEmail("Ján Zákazník", "Nohavice FOREST 1003", alts);
    expect(built.subject).toBe("Alternatívy k vášmu tovaru — Forestshop.sk");
    expect(built.html).toContain("Nohavice FOREST 1003");
    expect(built.html).toContain("Podkolienky BOBR");
    expect(built.html).toContain(alternativeSearchUrl("60116/90"));
    expect(built.text).toContain("Podkolienky BOBR");
  });

  it("bez alternatív ponúkne kontaktnú vetu namiesto zoznamu", () => {
    const built = buildAlternativeEmail("Ján Zákazník", "Nohavice FOREST 1003", []);
    expect(built.html).toContain("Radi vám pomôžeme nájsť vhodnú alternatívu");
    expect(built.html).not.toContain("<ul>");
  });

  it("HTML-escapuje meno alternatívy aj názov produktu", () => {
    const alts = buildAlternatives(["X"], new Map([["X", "<b>Zlý</b> názov"]]));
    const built = buildAlternativeEmail("Ján", '<i>Prod</i>', alts);
    expect(built.html).not.toContain("<b>Zlý</b>");
    expect(built.html).toContain("&lt;b&gt;Zlý&lt;/b&gt;");
    expect(built.html).not.toContain("<i>Prod</i>");
  });
});
