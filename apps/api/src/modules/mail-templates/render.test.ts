import { describe, expect, it } from "vitest";
import { renderEditedBody, renderTemplate, validateTemplateText, type TemplateContext } from "./render.js";

// issue 192. Čistá jednotka — žiadna databáza, žiadna sieť, nikdy sa nič
// neodosiela.

const CTX: TemplateContext = {
  meno_zakaznika: { kind: "text", text: "Ján Novák" },
  cislo_objednavky: { kind: "text", text: "20260123" },
  termin_vyzdvihnutia: { kind: "text", text: "" },
  odkaz_sledovanie: { kind: "link", url: "https://tandt.posta.sk/x", label: "https://tandt.posta.sk/x" },
  zoznam_nahrad: { kind: "list", textPrefix: "- ", items: [{ label: "Podkolienky BOBR", url: "https://e.sk/bobr" }] },
  prazdny_zoznam: { kind: "list", items: [] },
  // issue 347: zoznam s produktovou kartou — jeden prvok má obrázok+cenu,
  // druhý (nedohľadaný odkaz) ich nemá, aby test overil aj miešaný zoznam.
  zoznam_karta: {
    kind: "list",
    textPrefix: "- ",
    items: [
      { label: "Nohavice FOREST 1003", url: "https://e.sk/nohavice", imageUrl: "https://cdn.e.sk/nohavice.jpg", priceText: "64,90 €" },
      { label: "https://e.sk/nedohladany", url: "https://e.sk/nedohladany" },
    ],
  },
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
  it("v HTML je odrážkový zoznam s odkazmi (bez obrázka — nezmenené správanie)", () => {
    const out = renderTemplate({ subject: "x", body: "Náhrady:\n{{zoznam_nahrad}}" }, CTX);
    expect(out.html).toContain('<li><a href="https://e.sk/bobr" target="_blank">Podkolienky BOBR</a></li>');
  });

  // issue 347: názov a adresa idú na SAMOSTATNÉ riadky — nikdy "názov (url)",
  // aby text v poštovom klientovi nikdy neukázal adresu zdvojenú v zátvorke.
  it("v texte idú názov a adresa na samostatné riadky, nikdy adresa v zátvorke", () => {
    const out = renderTemplate({ subject: "x", body: "Náhrady:\n{{zoznam_nahrad}}" }, CTX);
    expect(out.text).toBe("Náhrady:\n- Podkolienky BOBR\nhttps://e.sk/bobr");
    expect(out.text).not.toContain("(https://e.sk/bobr)");
  });

  it("prázdny zoznam nevyrobí prázdny <ul>", () => {
    const out = renderTemplate({ subject: "x", body: "A\n{{prazdny_zoznam}}" }, CTX);
    expect(out.html).not.toContain("<ul>");
  });
});

// issue 347: majiteľov nahlásený bug — odkaz v e-maile mal ako text celú
// adresu (zdvojenú), žiadny obrázok produktu, kontakty stratené vo vete.
describe("renderTemplate — produktová karta v zozname (issue 347)", () => {
  it("prvok s obrázkom sa vykreslí ako karta (obrázok + klikací NÁZOV, nikdy holá adresa ako text odkazu)", () => {
    const out = renderTemplate({ subject: "x", body: "Ponúkame:\n{{zoznam_karta}}" }, CTX);
    expect(out.html).toContain('<img src="https://cdn.e.sk/nohavice.jpg"');
    expect(out.html).toContain('<a href="https://e.sk/nohavice"');
    expect(out.html).toContain(">Nohavice FOREST 1003<");
    expect(out.html).toContain("64,90");
    // odkaz na produkt sa nesmie ukázať ako holý text URL (pôvodný bug)
    expect(out.html).not.toContain(">https://e.sk/nohavice<");
  });

  it('karta má tlačidlo "Zobraziť produkt"', () => {
    const out = renderTemplate({ subject: "x", body: "{{zoznam_karta}}" }, CTX);
    expect(out.html).toContain("Zobraziť produkt");
  });

  it("prvok BEZ obrázka (nedohľadaný odkaz) v tom istom zozname sa vykreslí bez <img>, ale nezhodí zvyšok karty", () => {
    const out = renderTemplate({ subject: "x", body: "{{zoznam_karta}}" }, CTX);
    // druhý prvok nemá imageUrl — nesmie vyrobiť <img src="undefined">
    expect(out.html).not.toContain("undefined");
  });

  it("zoznam s obrázkom sa v HTML nevykreslí ako <ul><li> (karta nahrádza zoznam)", () => {
    const out = renderTemplate({ subject: "x", body: "{{zoznam_karta}}" }, CTX);
    expect(out.html).not.toContain("<li>");
  });

  it("v texte je pri prvku s cenou aj cena, adresa vždy na vlastnom riadku", () => {
    const out = renderTemplate({ subject: "x", body: "{{zoznam_karta}}" }, CTX);
    expect(out.text).toContain("Nohavice FOREST 1003");
    expect(out.text).toContain("64,90");
    expect(out.text).toContain("https://e.sk/nohavice");
    expect(out.text).not.toContain("(https://e.sk/nohavice)");
  });
});

// issue 347: spoločná kostra — hlavička + pätička s kontaktami, na VŠETKÝCH
// e-mailoch appky (kontakty dnes vedeli byť stratené vo vete).
describe("renderTemplate — spoločná HTML kostra (issue 347)", () => {
  it("HTML má hlavičku s odkazom na Forestshop.sk", () => {
    const out = renderTemplate({ subject: "x", body: "Ahoj." }, CTX);
    expect(out.html).toContain(">Forestshop.sk<");
    expect(out.html).toContain('href="https://www.forestshop.sk"');
  });

  it("HTML má oddelenú pätičku s klikacím telefónom, e-mailom a webom — nezávisle od obsahu tela šablóny", () => {
    const out = renderTemplate({ subject: "x", body: "Text bez akejkoľvek zmienky o kontaktoch." }, CTX);
    expect(out.html).toContain('href="tel:+421903670766"');
    expect(out.html).toContain('href="mailto:eshop@forestshop.sk"');
    expect(out.html).toContain("+421 903 670 766");
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

// issue 277: jednorazová RUČNÁ úprava textu tesne pred odoslaním — text je UŽ
// HOTOVÝ (zástupné polia dosadené obsluhou v okne náhľadu), takže sa
// NEPÚŠŤA cez `{{pole}}`/`**tučné**` šablónový engine znova. Prázdny riadok =
// nový odstavec (rovnaká konvencia ako šablóny).
describe("renderEditedBody — jednorazová ručná úprava (issue 277)", () => {
  it("prázdny riadok oddeľuje odstavce, jednoduchý riadok zalomí VNÚTRI odstavca", () => {
    const out = renderEditedBody("Dobrý deň,\nešte dopĺňam vetu.\n\nS pozdravom,\nobchod");
    expect(out.html).toContain("<p>Dobrý deň,<br>\n      ešte dopĺňam vetu.</p>");
    expect(out.html).toContain("<p>S pozdravom,<br>\n      obchod</p>");
    expect(out.text).toBe("Dobrý deň,\nešte dopĺňam vetu.\n\nS pozdravom,\nobchod");
  });

  // issue 347: ručne upravený text (okno náhľadu pred odoslaním) dostane
  // TÚ ISTÚ spoločnú kostru (hlavička/pätička) ako šablónou vygenerovaný
  // e-mail — kostra sa aplikuje na oboch vykresľovacích cestách.
  it("dostane rovnakú hlavičku/pätičku ako šablónou vygenerovaný e-mail (issue 347)", () => {
    const out = renderEditedBody("Ahoj.");
    expect(out.html).toContain(">Forestshop.sk<");
    expect(out.html).toContain('href="tel:+421903670766"');
    expect(out.html).toContain('href="mailto:eshop@forestshop.sk"');
  });

  it("HTML napísané obsluhou sa ESCAPUJE, nikdy sa nestane surovou značkou", () => {
    const out = renderEditedBody('Dopisujem <script>alert("x")</script> priamo.');
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>");
    expect(out.text).toContain("<script>"); // čistý text sa neescapuje, ide len ako telo e-mailu
  });

  it("prázdne odstavce (viac za sebou idúcich prázdnych riadkov) sa zahodia, nezostanú prázdne <p>", () => {
    const out = renderEditedBody("Prvý.\n\n\n\nDruhý.");
    expect(out.html.match(/<p>/g)).toHaveLength(2);
    expect(out.text).toBe("Prvý.\n\nDruhý.");
  });

  it("okolité biele znaky celého textu aj každého odseku sa orežú", () => {
    const out = renderEditedBody("  \n  Ahoj.  \n\n  ");
    expect(out.text).toBe("Ahoj.");
  });
});
