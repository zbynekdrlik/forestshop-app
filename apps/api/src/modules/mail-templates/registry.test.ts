import { describe, expect, it } from "vitest";
import { KONTAKT_EMAIL, KONTAKT_TELEFON, WEB_FORESTSHOP_LABEL } from "./context.js";
import { allowedPlaceholderNames, exampleContext, MAIL_TEMPLATE_KEYS, MAIL_TEMPLATE_KINDS, placeholdersFor } from "./registry.js";
import { renderTemplate, validateTemplateText } from "./render.js";

// issue 192: toto je poistka, že PÔVODNÉ znenie nemôže nikdy vyjsť pokazené.
// Uložiť sa dá len šablóna, ktorá prejde kontrolou — ale pôvodné znenia
// kontrolou neprechádzajú (v databáze nikdy nie sú), takže preklep v nich by
// sa inak prejavil až u zákazníka.
describe("pôvodné znenia e-mailov", () => {
  it.each(MAIL_TEMPLATE_KEYS)("%s prejde tou istou kontrolou ako uložená šablóna", (key) => {
    expect(validateTemplateText(MAIL_TEMPLATE_KINDS[key].defaultText, allowedPlaceholderNames(key))).toEqual([]);
  });

  it.each(MAIL_TEMPLATE_KEYS)("%s sa dá vyrenderovať a nie je prázdny", (key) => {
    const out = renderTemplate(MAIL_TEMPLATE_KINDS[key].defaultText, exampleContext(key));
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.html).toContain("<body");
    // Žiadne nedosadené pole neostane v odoslanom znení.
    expect(out.html).not.toContain("{{");
    expect(out.text).not.toContain("{{");
  });

  it.each(MAIL_TEMPLATE_KEYS)("%s má slovenský názov aj popis pre obsluhu", (key) => {
    expect(MAIL_TEMPLATE_KINDS[key].label.length).toBeGreaterThan(0);
    expect(MAIL_TEMPLATE_KINDS[key].description.length).toBeGreaterThan(0);
  });

  it.each(MAIL_TEMPLATE_KEYS)("%s ponúka ku každému poľu vysvetlenie a ukážkovú hodnotu", (key) => {
    const placeholders = placeholdersFor(key);
    expect(placeholders.length).toBeGreaterThan(0);
    for (const p of placeholders) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("kľúč každého druhu sedí s kľúčom v registri (preklep v mape by ostal neviditeľný)", () => {
    for (const key of MAIL_TEMPLATE_KEYS) expect(MAIL_TEMPLATE_KINDS[key].key).toBe(key);
  });

  it("zásielkové znenia sa navzájom líšia — eskalácia sa zlúčením nestratila", () => {
    const subjects = new Set((["posta_1", "posta_2", "posta_3", "posta_4"] as const).map((k) => MAIL_TEMPLATE_KINDS[k].defaultText.subject));
    expect(subjects.size).toBe(4);
  });
});

// issue 379: majiteľ nahlásil, že telefón (3×), e-mail (2×) a webová adresa
// (2×) sa v ODOSLANOM e-maile opakujú. Over PRE KAŽDÚ zákaznícku šablónu
// (okrem `supplier_order` — jediný čisto textový e-mail DODÁVATEĽOVI, ktorý
// kontaktnú pätičku výslovne vypína, `orders/mail.ts`), že hotový e-mail
// nesie KAŽDÝ kontaktný údaj PRESNE RAZ, v texte aj v HTML.
describe("kontaktné údaje v odoslanom e-maile sa objavia presne raz (issue 379)", () => {
  const CUSTOMER_FACING_KEYS = MAIL_TEMPLATE_KEYS.filter((k) => k !== "supplier_order");

  /** Počet výskytov `needle`, ktorý nie je súčasťou DLHŠIEHO reťazca (napr.
   * "www.forestshop.sk/vyhladavanie/..." v produktovom odkaze) — inak by
   * `nedostupne_alternativa`'s náhradový odkaz falošne pripočítal ďalší
   * výskyt webovej adresy. */
  function countStandalone(haystack: string, needle: string): number {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}(?![\\w/])`, "g");
    return (haystack.match(re) ?? []).length;
  }

  it.each(CUSTOMER_FACING_KEYS)("%s: textová verzia má telefón/e-mail/web presne raz", (key) => {
    const out = renderTemplate(MAIL_TEMPLATE_KINDS[key].defaultText, exampleContext(key));
    expect(countStandalone(out.text, KONTAKT_TELEFON)).toBe(1);
    expect(countStandalone(out.text, KONTAKT_EMAIL)).toBe(1);
    expect(countStandalone(out.text, WEB_FORESTSHOP_LABEL)).toBe(1);
  });

  it.each(CUSTOMER_FACING_KEYS)("%s: HTML verzia má VIDITEĽNÝ telefón/e-mail/web presne raz (hlavičkové logo sa nepočíta)", (key) => {
    const out = renderTemplate(MAIL_TEMPLATE_KINDS[key].defaultText, exampleContext(key));
    expect((out.html.match(new RegExp(`>${KONTAKT_TELEFON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`, "g")) ?? []).length).toBe(1);
    expect((out.html.match(new RegExp(`>${KONTAKT_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`, "g")) ?? []).length).toBe(1);
    expect((out.html.match(new RegExp(`>${WEB_FORESTSHOP_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`, "g")) ?? []).length).toBe(1);
  });

  it("supplier_order (dodávateľovi, nie zákazníkovi) NEMÁ kontaktnú pätičku — ostáva bajt na bajt ako predtým", () => {
    const out = renderTemplate(MAIL_TEMPLATE_KINDS.supplier_order.defaultText, exampleContext("supplier_order"), { footer: false });
    expect(out.text).not.toContain(KONTAKT_TELEFON);
    expect(out.text).not.toContain(KONTAKT_EMAIL);
    expect(out.text).not.toContain(WEB_FORESTSHOP_LABEL);
  });
});
