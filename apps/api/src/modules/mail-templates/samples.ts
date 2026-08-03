import { desc, isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders, products, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { alternativeSearchUrl } from "../nedostupne/constants.js";
import { itemsWord } from "../orders/pluralize.js";
import { trackingLink } from "../posta-uncollected/constants.js";
import { textValue } from "./context.js";
import { exampleContext, type MailTemplateKey } from "./registry.js";
import type { TemplateContext, TemplateValue } from "./render.js";

// issue 192, ticket: "Náhľad na skutočných dátach ešte pri úprave". Náhľad sa
// preto neskladá z vymyslených hodnôt, ale z toho, čo appka reálne má —
// posledná objednávka, skutočný názov tovaru, skutočné číslo zásielky.
// Keď sa vzorka nenájde (prázdna databáza, čerstvé nasadenie), použijú sa
// ukážkové hodnoty z registra: náhľad musí fungovať VŽDY, nikdy nesmie
// spadnúť na chýbajúcich dátach.

async function latestOrder(db: Database): Promise<{ customerName: string; code: string; packageNumber: string | null } | null> {
  const [row] = await db
    .select({ customerName: orders.customerName, code: orders.externalOrderId, packageNumber: orders.packageNumber })
    .from(orders)
    .orderBy(desc(orders.placedAt))
    .limit(1);
  return row ?? null;
}

async function latestOrderWithPackage(db: Database): Promise<{ customerName: string; packageNumber: string } | null> {
  const [row] = await db
    .select({ customerName: orders.customerName, packageNumber: orders.packageNumber })
    .from(orders)
    .where(isNotNull(orders.packageNumber))
    .orderBy(desc(orders.placedAt))
    .limit(1);
  return row?.packageNumber == null ? null : { customerName: row.customerName, packageNumber: row.packageNumber };
}

async function productSample(db: Database): Promise<{ name: string; relatedCodes: readonly string[] } | null> {
  const [row] = await db.select({ name: variants.name, productKey: variants.productKey }).from(variants).limit(1);
  if (row === undefined) return null;
  const [prod] = await db.select({ relatedCodes: products.relatedCodes }).from(products).limit(1);
  return { name: row.name, relatedCodes: prod?.relatedCodes ?? [] };
}

async function supplierSample(db: Database): Promise<string | null> {
  const [row] = await db.select({ supplier: products.supplier }).from(products).where(isNotNull(products.supplier)).limit(1);
  return row?.supplier ?? null;
}

/** Kontext pre náhľad — ukážkové hodnoty prekryté skutočnými dátami, ak sa
 * nejaké nájdu. Nikdy nevyhodí: pri akejkoľvek chybe dopytu ostanú ukážkové
 * hodnoty a náhľad ďalej funguje. */
export async function previewContext(db: Database, key: MailTemplateKey): Promise<TemplateContext> {
  const ctx: Record<string, TemplateValue> = exampleContext(key);
  try {
    if (key === "order_reminder") {
      const order = await latestOrder(db);
      if (order !== null) {
        ctx["meno_zakaznika"] = textValue(order.customerName);
        ctx["cislo_objednavky"] = textValue(order.code);
      }
    } else if (key === "nedostupne" || key === "nedostupne_alternativa") {
      const order = await latestOrder(db);
      if (order !== null) ctx["meno_zakaznika"] = textValue(order.customerName);
      if (key === "nedostupne_alternativa") {
        const product = await productSample(db);
        if (product !== null) {
          ctx["nazov_tovaru"] = textValue(product.name);
          if (product.relatedCodes.length > 0) {
            ctx["zoznam_nahrad"] = {
              kind: "list",
              textPrefix: "- ",
              items: product.relatedCodes.map((code) => ({ label: code, url: alternativeSearchUrl(code) })),
            };
          }
        }
      }
    } else if (key.startsWith("posta_")) {
      const shipment = await latestOrderWithPackage(db);
      if (shipment !== null) {
        ctx["meno_zakaznika"] = textValue(shipment.customerName);
        ctx["cislo_zasielky"] = textValue(shipment.packageNumber);
        ctx["odkaz_sledovanie"] = { kind: "link", url: trackingLink(shipment.packageNumber), label: trackingLink(shipment.packageNumber) };
      }
    } else {
      const supplier = await supplierSample(db);
      if (supplier !== null) ctx["dodavatel"] = textValue(supplier);
      const product = await productSample(db);
      if (product !== null) {
        ctx["pocet_poloziek"] = textValue("1");
        ctx["slovo_poloziek"] = textValue(itemsWord(1));
        ctx["zoznam_poloziek"] = { kind: "list", items: [{ label: `${product.name} | 1 ks` }] };
      }
    }
  } catch (error) {
    // Náhľad je pomocná funkcia — chýbajúca vzorka nikdy nesmie zhodiť
    // obrazovku, na ktorej majiteľ upravuje text.
    log.warn({ key, rawErrorMessage: error instanceof Error ? error.message : String(error) }, "náhľad e-mailu: vzorku skutočných dát sa nepodarilo načítať");
  }
  return ctx;
}
