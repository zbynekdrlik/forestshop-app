import { globalContext, textValue } from "../mail-templates/context.js";
import { renderTemplate, type MailTemplateText, type RenderedEmail } from "../mail-templates/render.js";

// Čistá logika (žiadna DB, žiadna sieť). Znenie e-mailu už NIE je natvrdo tu —
// issue 192 ho presunulo do upraviteľných šablón (`mail-templates/registry.ts`
// nesie pôvodné znenie, prevzaté doslovne z tohto súboru). Tu ostáva len to,
// čo appka vie o konkrétnom prípade: aké hodnoty do šablóny dosadiť.
// Volajúci (`send.ts`) si šablónu vypýta cez `resolveTemplate` — tieto funkcie
// zostávajú čisté a testovateľné bez databázy.

export type BuiltNedostupneEmail = RenderedEmail;

/** E-mail bez návrhu náhrady — pôvodné znenie zámerne NEUVÁDZA konkrétny
 * názov produktu (majiteľov schválený generický text, stará appka #183),
 * preto tento druh e-mailu ponúka len meno zákazníka. */
export function buildUnavailableEmail(template: MailTemplateText, customerName: string): BuiltNedostupneEmail {
  return renderTemplate(template, {
    ...globalContext(),
    meno_zakaznika: textValue((customerName || "").trim() || "zákazník"),
  });
}

/** E-mail s návrhom náhrady — produkt je nedostupný + majiteľove RUČNE
 * vložené odkazy na náhradné produkty (issue 238 — nahrádza pôvodný
 * automatický návrh z `product.relatedCodes`, ktorý majiteľ zamietol ako
 * "súvisiace produkty, nie náhrady"). Appka k ručne vloženému odkazu nepozná
 * žiadny názov/kód, preto je `label` samotná URL (klikateľný text = presne
 * to, čo majiteľ vložil). Prázdny zoznam náhrad je v šablóne podmienka
 * (`{{#ak zoznam_nahrad}}`), nie osobitná vetva v kóde. */
export function buildAlternativeEmail(
  template: MailTemplateText,
  customerName: string,
  itemName: string,
  replacementUrls: readonly string[],
): BuiltNedostupneEmail {
  return renderTemplate(template, {
    ...globalContext(),
    meno_zakaznika: textValue((customerName || "").trim() || "zákazník"),
    nazov_tovaru: textValue((itemName || "").trim() || "objednaný tovar"),
    zoznam_nahrad: {
      kind: "list",
      textPrefix: "- ",
      items: replacementUrls.map((url) => ({ label: url, url })),
    },
  });
}
