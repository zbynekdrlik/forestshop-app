import { describe, expect, it } from "vitest";
import { renderTemplate, validateTemplateText, type TemplateContext } from "./render.js";

// issue 192. Čistá jednotka — žiadna databáza, žiadna sieť, nikdy sa nič
// neodosiela.

const CTX: TemplateContext = {
  meno_zakaznika: { kind: "text", text: "Ján Novák" },
  cislo_objednavky: { kind: "text", text: "20260123" },
  termin_vyzdvihnutia: { kind: "text", text: "" },
  odkaz_sledovanie: { kind: "link", url: "https://tandt.posta.sk/x", label: "https://tandt.posta.sk/x" },
  zoznam_nahrad: { kind: "list", textPrefix: "- ", items: [{ label: "Podkolienky BOBR", url: "https://e.sk/bobr" }] },
  prazdny_zoznam: { kind: "list", items: [] },
};

const ALLOWED = new Set(Object.keys(CTX));

describe("renderTemplate — dosadzovanie polí", () => {
  it("dosadí text a odkaz do HTML aj do čistého textu", () => {
    const out = renderTemplate({ subject: "Objednávka {{cislo_objednavky}}", body: "Dobrý deň, {{meno_zakaznika}}.\n\nSledovanie: {{odkaz_sledovanie}}" }, CTX);
    expect(out.subject).toBe("Objednávka 20260123");
    expect(out.html).toContain("<p>Dobrý deň, Ján Novák.</p>");
    expect(out.html).toContain('<a href="https://tandt.posta.sk/x" target="_blank">https://tandt.posta.sk/x</a>');
    expect(out.text).toBe("Dobrý deň, Ján Novák.\n\nSledovanie: https://tandt.posta.sk/x");
  });

  it("neznáme pole sa ticho zahodí (uložiť sa taká šablóna vôbec nedá — viď kontrolu nižšie)", () => {
    const out = renderTemplate({ subject: "x", body: "A{{neexistuje}}B" }, CTX);
    expect(out.text).toBe("AB");
  });
});

describe("renderTemplate — tučné písmo", () => {
  it("spáruje hviezdičky OKOLO zástupného poľa (padli by do dvoch rôznych útržkov)", () => {
    const out = renderTemplate({ subject: "x", body: "Dobrý deň, **{{meno_zakaznika}}**," }, CTX);
    expect(out.html).toContain("<p>Dobrý deň, <strong>Ján Novák</strong>,</p>");
    expect(out.text).toBe("Dobrý deň, Ján Novák,");
  });

  it("dva nezávislé tučné úseky v tom istom texte sa nepomiešajú", () => {
    const out = renderTemplate({ subject: "x", body: "**{{meno_zakaznika}}** a **{{cislo_objednavky}}**" }, CTX);
    expect(out.html).toContain("<p><strong>Ján Novák</strong> a <strong>20260123</strong></p>");
  });

  it("nedovretá hviezdička sa uzavrie na konci odstavca — nikdy rozbité HTML", () => {
    const out = renderTemplate({ subject: "x", body: "**zabudnutá\n\nĎalší odstavec" }, CTX);
    expect(out.html).toContain("<p><strong>zabudnutá</strong></p>");
    expect(out.html).toContain("<p>Ďalší odstavec</p>");
  });
});

describe("renderTemplate — bezpečnosť", () => {
  it("HTML v hodnote poľa sa escapuje a NIKDY sa z neho nestane značka", () => {
    const out = renderTemplate({ subject: "x", body: "Meno: {{meno_zakaznika}}" }, { meno_zakaznika: { kind: "text", text: '<script>alert("x")</script>' } });
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>");
  });

  it("hviezdičky V HODNOTE poľa neformátujú — značku smie zapísať len šablóna", () => {
    const out = renderTemplate({ subject: "x", body: "Meno: {{meno_zakaznika}}" }, { meno_zakaznika: { kind: "text", text: "**tučný útok**" } });
    expect(out.html).toContain("**tučný útok**");
    expect(out.html).not.toContain("<strong>");
  });
});

describe("renderTemplate — podmienky", () => {
  const body = "{{#ak termin_vyzdvihnutia}}do {{termin_vyzdvihnutia}}{{inak}}čo najskôr{{/ak}}";

  it("prázdna hodnota vezme vetvu {{inak}}", () => {
    expect(renderTemplate({ subject: "x", body }, CTX).text).toBe("čo najskôr");
  });

  it("vyplnená hodnota vezme prvú vetvu", () => {
    const ctx = { ...CTX, termin_vyzdvihnutia: { kind: "text" as const, text: "12. 8. 2026" } };
    expect(renderTemplate({ subject: "x", body }, ctx).text).toBe("do 12. 8. 2026");
  });

  it("prázdny zoznam je pre podmienku nevyplnená hodnota", () => {
    const out = renderTemplate({ subject: "x", body: "{{#ak prazdny_zoznam}}je{{inak}}nie je{{/ak}}" }, CTX);
    expect(out.text).toBe("nie je");
  });
});

describe("renderTemplate — zoznam", () => {
  it("v HTML je odrážkový zoznam s odkazmi, v texte riadky s predponou", () => {
    const out = renderTemplate({ subject: "x", body: "Náhrady:\n{{zoznam_nahrad}}" }, CTX);
    expect(out.html).toContain('<li><a href="https://e.sk/bobr" target="_blank">Podkolienky BOBR</a></li>');
    expect(out.text).toBe("Náhrady:\n- Podkolienky BOBR (https://e.sk/bobr)");
  });

  it("prázdny zoznam nevyrobí prázdny <ul>", () => {
    const out = renderTemplate({ subject: "x", body: "A\n{{prazdny_zoznam}}" }, CTX);
    expect(out.html).not.toContain("<ul>");
  });
});

describe("renderTemplate — predmet", () => {
  it("zalomenia v predmete sa zlúčia do jedného riadku", () => {
    expect(renderTemplate({ subject: "  Prvý\n\ndruhý  ", body: "x" }, CTX).subject).toBe("Prvý druhý");
  });
});

describe("validateTemplateText", () => {
  it("platná šablóna nevráti žiadnu chybu", () => {
    expect(validateTemplateText({ subject: "Vec {{cislo_objednavky}}", body: "Ahoj {{meno_zakaznika}}" }, ALLOWED)).toEqual([]);
  });

  it("neznáme pole sa odmietne a chyba ho pomenuje", () => {
    const errors = validateTemplateText({ subject: "x", body: "{{neznamy_kluc}}" }, ALLOWED);
    expect(errors.join(" ")).toContain("{{neznamy_kluc}}");
  });

  it("pole použité v podmienke sa tiež kontroluje", () => {
    const errors = validateTemplateText({ subject: "x", body: "{{#ak vymysleny}}a{{/ak}}" }, ALLOWED);
    expect(errors.join(" ")).toContain("{{vymysleny}}");
  });

  it("neuzavretá podmienka sa odmietne", () => {
    expect(validateTemplateText({ subject: "x", body: "{{#ak meno_zakaznika}}a" }, ALLOWED).join(" ")).toContain("nie je uzavretá");
  });

  it("vnorená podmienka sa odmietne", () => {
    const body = "{{#ak meno_zakaznika}}{{#ak cislo_objednavky}}a{{/ak}}{{/ak}}";
    expect(validateTemplateText({ subject: "x", body }, ALLOWED).join(" ")).toContain("vnorená");
  });

  it("{{/ak}} bez otvorenia sa odmietne", () => {
    expect(validateTemplateText({ subject: "x", body: "a{{/ak}}" }, ALLOWED).join(" ")).toContain("navyše");
  });

  it("prázdny predmet aj prázdne telo sa odmietnu", () => {
    const errors = validateTemplateText({ subject: "   ", body: "\n" }, ALLOWED);
    expect(errors).toHaveLength(2);
  });
});
