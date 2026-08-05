// issue 192: majiteľ si upravuje ZNENIE e-mailov, nie ich HTML. Šablóna je
// obyčajný text so zástupnými poľami; táto jednotka z nej vyrobí HTML aj
// čistotextovú verziu. Escapovanie tak ostáva výhradne na appke — meno
// zákazníka, názov tovaru ani nič iné sa nikdy nedostane do HTML surové, aj
// keby majiteľ do šablóny napísal čokoľvek.
//
// Podporovaná značka (zámerne minimum, viď návrhový komentár na tickete):
//   {{pole}}                        zástupné pole (text / odkaz / zoznam)
//   {{#ak pole}}…{{inak}}…{{/ak}}   podmienená časť (bez vnorenia)
//   **tučné**
//   prázdny riadok = nový odstavec, jednoduchý riadok = zalomenie

export interface TemplateListItem {
  readonly label: string;
  readonly url?: string;
}

export type TemplateValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly label: string }
  | { readonly kind: "list"; readonly items: readonly TemplateListItem[]; readonly textPrefix?: string };

export type TemplateContext = Readonly<Record<string, TemplateValue>>;

export interface MailTemplateText {
  readonly subject: string;
  readonly body: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const PLACEHOLDER_NAME_RE = /^[a-z][a-z0-9_]*$/;
const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

type Node =
  | { readonly t: "lit"; readonly s: string }
  | { readonly t: "ph"; readonly name: string }
  | { readonly t: "if"; readonly name: string; readonly then: readonly Node[]; readonly other: readonly Node[] };

export class TemplateSyntaxError extends Error {}

/** Rozloží šablónu na uzly. Vyhodí `TemplateSyntaxError` s vetou po slovensky —
 * volajúci ju ukáže obsluhe (`validateTemplateText`), nikdy zákazníkovi. */
function parse(source: string): readonly Node[] {
  const root: Node[] = [];
  // Naraz smie byť otvorená najviac JEDNA podmienka — vnorenie je zakázané
  // zámerne (znenia e-mailov ho nepotrebujú a vnorené vetvy sa v textovom
  // poli nedajú prehľadne skontrolovať).
  let open: { readonly name: string; readonly then: Node[]; readonly other: Node[]; inElse: boolean } | null = null;
  const push = (node: Node): void => {
    if (open === null) root.push(node);
    else if (open.inElse) open.other.push(node);
    else open.then.push(node);
  };

  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null = TOKEN_RE.exec(source);
  while (m !== null) {
    if (m.index > last) push({ t: "lit", s: source.slice(last, m.index) });
    last = m.index + m[0].length;
    const inner = (m[1] ?? "").trim();

    if (inner.startsWith("#ak")) {
      const name = inner.slice(3).trim();
      if (!PLACEHOLDER_NAME_RE.test(name)) throw new TemplateSyntaxError(`Podmienka „{{#ak ${name}}}“ nemá platný názov poľa.`);
      if (open !== null) throw new TemplateSyntaxError("Podmienka vnorená v inej podmienke sa nepodporuje — rozdeľte text na dve samostatné podmienky.");
      open = { name, then: [], other: [], inElse: false };
    } else if (inner === "inak") {
      if (open === null) throw new TemplateSyntaxError("„{{inak}}“ je mimo podmienky — chýba k nemu „{{#ak pole}}“.");
      if (open.inElse) throw new TemplateSyntaxError("Jedna podmienka smie mať najviac jedno „{{inak}}“.");
      open.inElse = true;
    } else if (inner === "/ak") {
      if (open === null) throw new TemplateSyntaxError("„{{/ak}}“ je navyše — chýba k nemu „{{#ak pole}}“.");
      root.push({ t: "if", name: open.name, then: open.then, other: open.other });
      open = null;
    } else {
      if (!PLACEHOLDER_NAME_RE.test(inner)) {
        throw new TemplateSyntaxError(`„{{${inner}}}“ nie je platné zástupné pole (povolené sú malé písmená, číslice a podčiarkovník).`);
      }
      push({ t: "ph", name: inner });
    }
    m = TOKEN_RE.exec(source);
  }
  if (open !== null) throw new TemplateSyntaxError(`Podmienka „{{#ak ${open.name}}}“ nie je uzavretá — chýba „{{/ak}}“.`);
  if (last < source.length) push({ t: "lit", s: source.slice(last) });
  return root;
}

export function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// `**tučné**` sa spracúva ako DVOJICA ZNAČIEK v prúde útržkov, nie ako
// náhrada regulárnym výrazom nad jedným reťazcom. Dôvod je vecný: značky
// bežne obklopujú zástupné pole (`**{{meno_zakaznika}}**`), takže otváracia a
// zatváracia hviezdička padnú do DVOCH RÔZNYCH doslovných útržkov a regulárny
// výraz by ich nikdy nespároval — namiesto toho by spároval zatváraciu
// hviezdičku s otváracou o niekoľko odstavcov nižšie a vyrobil rozbité HTML
// (nájdené testom pri prechode na šablóny, issue 192).
//
// Značka sa hľadá VÝHRADNE v doslovnom texte šablóny, nikdy v dosadenej
// hodnote poľa — meno zákazníka s hviezdičkami tak nemá ako do e-mailu
// prepašovať formátovanie.

function isFilled(value: TemplateValue | undefined): boolean {
  if (value === undefined) return false;
  if (value.kind === "text") return value.text.trim() !== "";
  if (value.kind === "link") return value.url.trim() !== "";
  return value.items.length > 0;
}

// Medzikrok medzi uzlami a hotovým výstupom: doslovné zalomenia zo šablóny sa
// musia dať odlíšiť od obsahu dosadených polí (zoznam náhrad nesmie sám od
// seba založiť nový odstavec), preto sa neskladá jeden reťazec, ktorý by sa
// potom delil, ale postupnosť bezpečných útržkov a značiek zalomenia.
type Piece =
  | { readonly p: "frag"; readonly s: string }
  | { readonly p: "bold" }
  | { readonly p: "br" }
  | { readonly p: "par" }
  | { readonly p: "list"; readonly items: readonly TemplateListItem[]; readonly textPrefix: string };

type Mode = "html" | "text";

function litPieces(raw: string, mode: Mode): Piece[] {
  const prepared = mode === "html" ? htmlEscape(raw) : raw;
  const out: Piece[] = [];
  const paragraphs = prepared.split(/\n[ \t]*\n+/);
  paragraphs.forEach((paragraph, pi) => {
    if (pi > 0) out.push({ p: "par" });
    paragraph.split("\n").forEach((line, li) => {
      if (li > 0) out.push({ p: "br" });
      line.split("**").forEach((part, si) => {
        if (si > 0) out.push({ p: "bold" });
        if (part !== "") out.push({ p: "frag", s: part });
      });
    });
  });
  return out;
}

function valuePieces(value: TemplateValue | undefined, mode: Mode): Piece[] {
  if (value === undefined) return [];
  if (value.kind === "text") {
    return value.text === "" ? [] : [{ p: "frag", s: mode === "html" ? htmlEscape(value.text) : value.text }];
  }
  if (value.kind === "link") {
    if (value.url === "") return [];
    const label = value.label === "" ? value.url : value.label;
    if (mode === "text") return [{ p: "frag", s: label === value.url ? value.url : `${label} (${value.url})` }];
    return [{ p: "frag", s: `<a href="${htmlEscape(value.url)}" target="_blank">${htmlEscape(label)}</a>` }];
  }
  return [{ p: "list", items: value.items, textPrefix: value.textPrefix ?? "" }];
}

function toPieces(nodes: readonly Node[], ctx: TemplateContext, mode: Mode): Piece[] {
  const out: Piece[] = [];
  for (const node of nodes) {
    if (node.t === "lit") out.push(...litPieces(node.s, mode));
    else if (node.t === "ph") out.push(...valuePieces(ctx[node.name], mode));
    else out.push(...toPieces(isFilled(ctx[node.name]) ? node.then : node.other, ctx, mode));
  }
  return out;
}

function assembleHtml(pieces: readonly Piece[]): string {
  const blocks: string[] = [];
  let current: string[] = [];
  let boldOpen = false;
  const flush = (): void => {
    // Nedovretá značka sa uzavrie na konci odstavca — rozbité HTML sa nikdy
    // nesmie dostať k zákazníkovi, ani keď majiteľ hviezdičku zabudne.
    if (boldOpen) {
      current.push("</strong>");
      boldOpen = false;
    }
    const body = current.join("").trim();
    current = [];
    if (body !== "") blocks.push(`    <p>${body}</p>`);
  };
  for (const piece of pieces) {
    if (piece.p === "frag") current.push(piece.s);
    else if (piece.p === "bold") {
      current.push(boldOpen ? "</strong>" : "<strong>");
      boldOpen = !boldOpen;
    } else if (piece.p === "br") current.push("<br>\n      ");
    else if (piece.p === "par") flush();
    else {
      flush();
      const items = piece.items
        .map((i) => {
          const label = htmlEscape(i.label);
          const shown = i.url === undefined || i.url === "" ? label : `<a href="${htmlEscape(i.url)}" target="_blank">${label}</a>`;
          return `      <li>${shown}</li>`;
        })
        .join("\n");
      if (items !== "") blocks.push(`    <ul>\n${items}\n    </ul>`);
    }
  }
  flush();
  return [
    "<!DOCTYPE html>",
    "<html>",
    '  <body style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">',
    ...blocks,
    "  </body>",
    "</html>",
  ].join("\n");
}

function assembleText(pieces: readonly Piece[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const body = current.join("").trim();
    current = [];
    if (body !== "") paragraphs.push(body);
  };
  for (const piece of pieces) {
    if (piece.p === "frag") current.push(piece.s);
    else if (piece.p === "bold") continue; // čistý text tučné písmo nemá
    else if (piece.p === "br") current.push("\n");
    else if (piece.p === "par") flush();
    else {
      const lines = piece.items
        .map((i) => `${piece.textPrefix}${i.label}${i.url === undefined || i.url === "" ? "" : ` (${i.url})`}`)
        .join("\n");
      if (lines !== "") current.push(lines);
    }
  }
  flush();
  return paragraphs.join("\n\n");
}

function assembleSubject(pieces: readonly Piece[]): string {
  return pieces
    .map((piece) => {
      if (piece.p === "frag") return piece.s;
      if (piece.p === "bold") return "";
      if (piece.p === "list") return piece.items.map((i) => i.label).join(", ");
      return " ";
    })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function renderTemplate(template: MailTemplateText, ctx: TemplateContext): RenderedEmail {
  const bodyNodes = parse(template.body);
  return {
    subject: assembleSubject(toPieces(parse(template.subject), ctx, "text")),
    html: assembleHtml(toPieces(bodyNodes, ctx, "html")),
    text: assembleText(toPieces(bodyNodes, ctx, "text")),
  };
}

export interface RenderedEditedBody {
  readonly html: string;
  readonly text: string;
}

/**
 * issue 277: jednorazová RUČNÁ úprava textu tesne pred odoslaním (okno
 * náhľadu, `MailPreviewDialog.tsx`) — obsluha edituje UŽ HOTOVÝ text (zástupné
 * polia dosadené, žiadna `{{pole}}`/`**tučné**` šablónová syntax), preto sa
 * NEPÚŠŤA cez `parse`/placeholder engine znova (`renderTemplate`). Prázdny
 * riadok = nový odstavec (rovnaká konvencia ako šablóny), jednoduchý riadok v
 * odstavci = zalomenie. Escapovanie je VÝHRADNE tu — obsluha smie napísať
 * čokoľvek, nikdy sa to nezapíše ako surové HTML (rovnaká disciplína ako
 * `assembleHtml` vyššie).
 */
export function renderEditedBody(text: string): RenderedEditedBody {
  const paragraphs = text
    .replaceAll("\r\n", "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const htmlParagraphs = paragraphs.map((p) => `    <p>${htmlEscape(p).replaceAll("\n", "<br>\n      ")}</p>`);
  const html = [
    "<!DOCTYPE html>",
    "<html>",
    '  <body style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">',
    ...htmlParagraphs,
    "  </body>",
    "</html>",
  ].join("\n");
  return { html, text: paragraphs.join("\n\n") };
}

/** Mená zástupných polí použitých v texte — vrátane tých v podmienkach. */
function collectNames(nodes: readonly Node[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.t === "ph") into.add(node.name);
    else if (node.t === "if") {
      into.add(node.name);
      collectNames(node.then, into);
      collectNames(node.other, into);
    }
  }
}

/** Kontrola PRED uložením: prázdny predmet/telo, chybná značka, neznáme pole.
 * Vracia vety po slovensky (prázdne pole = šablóna je v poriadku). Toto je
 * jediná poistka proti tomu, aby sa preklep v názve poľa dostal k zákazníkovi
 * ako surový text — samotné renderovanie neznáme pole ticho zahodí. */
export function validateTemplateText(template: MailTemplateText, allowedNames: ReadonlySet<string>): readonly string[] {
  const errors: string[] = [];
  if (template.subject.trim() === "") errors.push("Predmet e-mailu nesmie byť prázdny.");
  if (template.body.trim() === "") errors.push("Text e-mailu nesmie byť prázdny.");
  const used = new Set<string>();
  const sources: readonly (readonly [string, string])[] = [
    ["Predmet", template.subject],
    ["Text", template.body],
  ];
  for (const [label, source] of sources) {
    try {
      collectNames(parse(source), used);
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const unknown = [...used].filter((name) => !allowedNames.has(name)).sort();
  if (unknown.length > 0) {
    errors.push(`Neznáme zástupné pole: ${unknown.map((n) => `{{${n}}}`).join(", ")}. Vyberte pole zo zoznamu vpravo.`);
  }
  return errors;
}
