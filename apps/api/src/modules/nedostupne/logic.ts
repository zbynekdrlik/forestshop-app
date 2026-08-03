import { globalContext, textValue } from "../mail-templates/context.js";
import { renderTemplate, type MailTemplateText, type RenderedEmail } from "../mail-templates/render.js";
import { alternativeSearchUrl } from "./constants.js";

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

export interface EmailAlternative {
  readonly code: string;
  readonly name: string;
  readonly url: string;
}

/** Vytvorí zoznam náhradných produktov z RAW kódov (`product.related_codes`)
 * + rozlíšeného mena (`namesByCode` — vopred vyriešené DB dopytom,
 * `queries.ts`'s `resolveAlternativeNames`). Neznámy kód (nikdy nevidený
 * variant/pairCode) padá späť na SEBA SAMÉHO ako meno — rovnaký zámer ako
 * stará appka's `code2name.get(rc, rc)`, nikdy sa nezahadzuje. URL je vždy
 * klikateľný vyhľadávací fallback (`alternativeSearchUrl`, `constants.ts`).*/
export function buildAlternatives(codes: readonly string[], namesByCode: ReadonlyMap<string, string>): readonly EmailAlternative[] {
  return codes.map((code) => ({ code, name: namesByCode.get(code) ?? code, url: alternativeSearchUrl(code) }));
}

/** E-mail s návrhom náhrady — produkt je nedostupný + priamo priradené
 * alternatívy (relatedProduct*), rovnaký zámer ako stará appka's
 * `build_alternative_email`. Prázdny zoznam náhrad je v šablóne podmienka
 * (`{{#ak zoznam_nahrad}}`), nie osobitná vetva v kóde. */
export function buildAlternativeEmail(
  template: MailTemplateText,
  customerName: string,
  itemName: string,
  alternatives: readonly EmailAlternative[],
): BuiltNedostupneEmail {
  return renderTemplate(template, {
    ...globalContext(),
    meno_zakaznika: textValue((customerName || "").trim() || "zákazník"),
    nazov_tovaru: textValue((itemName || "").trim() || "objednaný tovar"),
    zoznam_nahrad: {
      kind: "list",
      textPrefix: "- ",
      items: alternatives.map((a) => ({ label: a.name.trim() || a.code, url: a.url })),
    },
  });
}
