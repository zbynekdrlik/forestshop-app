import { describe, expect, it } from "vitest";
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
