import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, products, supplierContacts, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import type { MailTransport } from "../mail/transport.js";
import { NEZNAMY_DODAVATEL } from "./queries.js";
import { itemsWord } from "./pluralize.js";

// Jeden agregovaný riadok objednávky pre daného dodávateľa — súčet
// množstva podľa `variant.code` naprieč VŠETKÝMI otvorenými objednávkami
// toho dodávateľa (veľkosť je súčasťou kódu variantu, netreba samostatný
// agregačný kľúč ako stará appka's `code + size`, viď komentár na tickete).
// `externalCode`/`supplierUrl` (issue 67) sú vlastnosti VARIANTU (kód) resp.
// ODVODENÉ z produktu (odkaz) — stabilné pre daný `variantCode` naprieč
// všetkými agregovanými objednávkami, preto sa neagregujú, len prenesú.
export interface SupplierOrderMailLine {
  readonly variantCode: string;
  readonly sizeLabel: string | null;
  readonly quantity: number;
  readonly externalCode: string | null;
  readonly supplierUrl: string | null;
}

export interface SupplierOrderMailContent {
  readonly supplier: string;
  readonly to: string | null;
  readonly subject: string;
  readonly body: string;
  readonly itemCount: number;
}

// Jeden riadok textu = `.filter(Boolean).join(' | ')` — rovnaká kostra ako
// stará appka's `orderCopyLines` (`app.js:2076-2142`, `[kód, grube-id,
// veľkosť, N ks, url]`). issue 67 doplnil presne tie dve chýbajúce polia —
// `externalCode` (kód dodávateľa, staré app's "grube id" bolo len
// dodávateľ-špecifické pomenovanie toho istého konceptu) a `supplierUrl`
// (odkaz, extrahovaný z `product.internalNote`) — do rovnakého poradia ako
// stará appka. Keď je `null` (dodávateľ v exporte kód/odkaz neuviedol),
// segment sa v `filter(Boolean)` jednoducho vynechá, presne ako doteraz.
function formatSupplierOrderMailLine(line: SupplierOrderMailLine): string {
  return [
    line.variantCode,
    line.externalCode !== null ? `kód ${line.externalCode}` : "",
    line.sizeLabel ?? "",
    `${String(line.quantity)} ks`,
    line.supplierUrl ?? "",
  ]
    .filter((part) => part !== "")
    .join(" | ");
}

// Čistá funkcia (žiadna DB) — ľahko testovateľná na hraniciach skloňovania
// (0, 1, 2, 4, 5) bez behu integračných testov.
export function formatSupplierOrderMailText(
  supplier: string,
  lines: readonly SupplierOrderMailLine[],
): { readonly subject: string; readonly body: string } {
  const subject = `Objednávka — ${supplier} (${String(lines.length)} ${itemsWord(lines.length)})`;
  const body = [subject, ...lines.map(formatSupplierOrderMailLine)].join("\n");
  return { subject, body };
}

// Len riadky v stave "objednane" (ešte neposlané/nevybavené dodávateľovi) —
// rovnaký zámer ako stará appka's `outstandingOf`/`!isHandled`: mail má niesť
// NOVÉ položky na objednanie, nie tie, čo manažér už predtým ručne posunul
// ďalej (čaká sa/skladom/nedostupné). Poradie riadkov je deterministické
// (vzostupne podľa kódu variantu) — stará appka triedila podľa poradia
// zobrazenia v tabe, čo tu nemá priamy ekvivalent; abecedné poradie je
// stabilné a ľahko overiteľné, nie hádanie chýbajúceho zdroja dát.
async function loadOutstandingLines(db: Database, supplier: string): Promise<SupplierOrderMailLine[]> {
  const supplierCondition = supplier === NEZNAMY_DODAVATEL ? isNull(products.supplier) : eq(products.supplier, supplier);
  const rows = await db
    .select({
      variantCode: orderLines.variantCode,
      sizeLabel: variants.sizeLabel,
      quantity: orderLines.quantity,
      externalCode: variants.externalCode,
      internalNote: products.internalNote,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .innerJoin(products, eq(products.key, variants.productKey))
    .where(and(supplierCondition, eq(orderLines.state, "objednane")))
    .orderBy(asc(orderLines.variantCode));

  const byCode = new Map<string, SupplierOrderMailLine>();
  for (const row of rows) {
    const existing = byCode.get(row.variantCode);
    if (existing === undefined) {
      byCode.set(row.variantCode, {
        variantCode: row.variantCode,
        sizeLabel: row.sizeLabel,
        quantity: row.quantity,
        externalCode: row.externalCode,
        supplierUrl: extractSupplierLink(row.internalNote).url,
      });
    } else {
      byCode.set(row.variantCode, { ...existing, quantity: existing.quantity + row.quantity });
    }
  }
  return [...byCode.values()];
}

// Náhľad aj odoslanie počítajú obsah TOU ISTOU cestou — server vždy prepočíta
// zo skutočného aktuálneho stavu DB, nikdy nedôveruje telu, ktoré by poslal
// klient (obrana proti pretekaniu/manipulácii medzi náhľadom a odoslaním).
export async function buildSupplierOrderMailContent(db: Database, supplier: string): Promise<SupplierOrderMailContent> {
  const lines = await loadOutstandingLines(db, supplier);
  const [contact] = await db
    .select({ email: supplierContacts.email })
    .from(supplierContacts)
    .where(eq(supplierContacts.supplier, supplier))
    .limit(1);
  const { subject, body } = formatSupplierOrderMailText(supplier, lines);
  return { supplier, to: contact?.email ?? null, subject, body, itemCount: lines.length };
}

export type SendSupplierOrderMailResult =
  | { readonly status: "sent"; readonly to: string; readonly itemCount: number }
  | { readonly status: "no_email" }
  | { readonly status: "no_items" }
  | { readonly status: "send_failed" };

// Odoslanie NEMENÍ stav žiadneho riadku objednávky (#31, návrhový komentár
// na tickete) — manažér stav ("čaká sa" a ďalej) prepína ručne cez existujúci
// select, presne ako doteraz. Automatická zmena stavu by pridala správanie,
// ktoré zadanie nežiada.
export async function sendSupplierOrderMail(
  db: Database,
  transport: MailTransport,
  supplier: string,
): Promise<SendSupplierOrderMailResult> {
  const content = await buildSupplierOrderMailContent(db, supplier);
  if (content.to === null) return { status: "no_email" };
  if (content.itemCount === 0) return { status: "no_items" };

  try {
    await transport({ to: content.to, subject: content.subject, text: content.body });
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ supplier, rawErrorMessage }, "odoslanie objednávky dodávateľovi zlyhalo (SMTP)");
    return { status: "send_failed" };
  }
  return { status: "sent", to: content.to, itemCount: content.itemCount };
}
