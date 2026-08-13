import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingCandidateSets, pairingDecisions, products } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { upsertProductSupplierLink, type UpsertExecutor } from "../orders/supplier-link-assignment.js";

// issue 387 E6 — "Eshop → Párovanie": aplikácia ČLOVEKOVHO rozhodnutia.
// Design komentár na tickete (issue 387 E6) — guard proti súbežnému prepisu
// je "posledný zápis vyhráva" (`onConflictDoUpdate`, atomický v Postgrese,
// rovnaký vzor ako `upsertProductSupplierLink` samo), NIE optimistický
// zámok — konflikt sa zaznamenáva SPÄTNE cez audit (`previousStatus`/
// `previousUrl`), nikdy sa mu nepredchádza zamykaním.

export type PairingDecisionStatus = "good" | "manual" | "unavailable" | "discontinued" | "split";

interface BaseInput {
  readonly productKey: string;
  readonly actorUserId: string;
  readonly now: Date;
}

// Diskriminovaná únia presne podľa design komentára: `good` (server SÁM
// dohľadá `chosenUrl` z `pairing_candidate_set` — nikdy sa nedôveruje
// klientom poslanej URL pre "AI kandidáta"), `manual` (klient POSIELA URL —
// vybraný kandidát ALEBO ručne vpísaná adresa, zod validácia na HTTP hranici
// rovnaká ako `product-links`), `unavailable`/`discontinued` (žiadna URL),
// `revert` (DELETE riadku).
//
// issue 399 — `split` (žiadna URL, rovnaký tvar ako `unavailable`/
// `discontinued`): manažér už nastavil per-veľkosť linky cez
// `POST .../variant-link` (`variant-links.ts`, samostatná zápisová cesta,
// NEZDIEĽANÁ transakcia — per-veľkosť riadky sa ukladajú NEZÁVISLE, jeden
// po druhom, PRED týmto rozhodnutím) — toto len OZNAČÍ produkt ako
// rozdelený/zrevidovaný. Design komentár na tickete, sekcia "Prístup 1".
export type SetPairingDecisionInput =
  | (BaseInput & { readonly status: "good" })
  | (BaseInput & { readonly status: "manual"; readonly url: string })
  | (BaseInput & { readonly status: "unavailable" })
  | (BaseInput & { readonly status: "discontinued" })
  | (BaseInput & { readonly status: "split" })
  | (BaseInput & { readonly status: "revert" });

export type SetPairingDecisionResult = "ok" | "not_found" | "no_candidate";

interface UpsertDecisionRowInput {
  readonly productKey: string;
  readonly status: PairingDecisionStatus;
  readonly url: string | null;
  readonly actorUserId: string;
  readonly now: Date;
}

// Zdieľané jadro pre KAŽDÝ neprázdny (non-revert) zápis nižšie — upsert
// `pairing_decision` riadku + auditný záznam nesúci PREDOŠLÚ hodnotu (rovnaký
// princíp ako `upsertProductSupplierLink`'s vlastný audit). `state_synced_at`
// sa VŽDY nuluje — predošlý sync (ak nejaký existoval) sa týkal STARÉHO
// stavu, E7 ho musí zistiť/odoslať odznova.
async function upsertPairingDecisionRow(tx: UpsertExecutor, input: UpsertDecisionRowInput): Promise<void> {
  const [previous] = await tx
    .select({ status: pairingDecisions.status, url: pairingDecisions.url })
    .from(pairingDecisions)
    .where(eq(pairingDecisions.productKey, input.productKey))
    .limit(1);

  await tx
    .insert(pairingDecisions)
    .values({
      productKey: input.productKey,
      status: input.status,
      url: input.url,
      decidedBy: input.actorUserId,
      decidedAt: input.now,
      updatedAt: input.now,
      stateSyncedAt: null,
    })
    .onConflictDoUpdate({
      target: pairingDecisions.productKey,
      set: {
        status: input.status,
        url: input.url,
        decidedBy: input.actorUserId,
        decidedAt: input.now,
        updatedAt: input.now,
        stateSyncedAt: null,
      },
    });

  await record(tx, {
    at: input.now,
    actorUserId: input.actorUserId,
    action: "pairing_decision.changed",
    entity: "pairing_decision",
    entityId: input.productKey,
    data: {
      productKey: input.productKey,
      previousStatus: previous?.status ?? null,
      previousUrl: previous?.url ?? null,
      newStatus: input.status,
      newUrl: input.url,
    },
  });
}

export async function setPairingDecision(db: Database, input: SetPairingDecisionInput): Promise<SetPairingDecisionResult> {
  return db.transaction(async (tx) => {
    if (input.status === "revert") {
      // Zámerne NEMAŽE odkaz v `product_supplier_link_override` (design
      // komentár na tickete) — človek ho môže chcieť ponechať aj po
      // vrátení rozhodnutia späť na "nezrevidované".
      const [previous] = await tx
        .select({ status: pairingDecisions.status, url: pairingDecisions.url })
        .from(pairingDecisions)
        .where(eq(pairingDecisions.productKey, input.productKey))
        .limit(1);
      // Idempotentné: "↩ Vrátiť" na produkte, čo už žiadne rozhodnutie nemá
      // (dvojklik / zastaraná karta), je no-op ok, nikdy chyba — nič sa
      // nezmenilo, takže sa ani nepíše audit záznam (rovnaký princíp ako
      // "audit `entity` = to, čo sa REÁLNE mutuje", `.claude/rules/orders.md`).
      if (previous === undefined) return "ok";

      await tx.delete(pairingDecisions).where(eq(pairingDecisions.productKey, input.productKey));
      await record(tx, {
        at: input.now,
        actorUserId: input.actorUserId,
        action: "pairing_decision.reverted",
        entity: "pairing_decision",
        entityId: input.productKey,
        data: { productKey: input.productKey, previousStatus: previous.status, previousUrl: previous.url },
      });
      return "ok";
    }

    if (input.status === "good") {
      const [set] = await tx
        .select({ chosenUrl: pairingCandidateSets.chosenUrl })
        .from(pairingCandidateSets)
        .where(eq(pairingCandidateSets.productKey, input.productKey))
        .limit(1);
      if (set === undefined) return "not_found";
      // Obranná kontrola — frontend zobrazuje "✓ Dobré" LEN keď karta má
      // `chosenCandidate` (`chosenUrl !== null`), ale server nikdy nedôveruje
      // klientovmu UI stavu.
      if (set.chosenUrl === null) return "no_candidate";

      await upsertProductSupplierLink(tx, {
        productKey: input.productKey,
        url: set.chosenUrl,
        actorUserId: input.actorUserId,
        now: input.now,
        lineId: null,
      });
      await upsertPairingDecisionRow(tx, {
        productKey: input.productKey,
        status: "good",
        url: set.chosenUrl,
        actorUserId: input.actorUserId,
        now: input.now,
      });
      return "ok";
    }

    if (input.status === "manual") {
      const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.key, input.productKey)).limit(1);
      if (product === undefined) return "not_found";

      await upsertProductSupplierLink(tx, {
        productKey: input.productKey,
        url: input.url,
        actorUserId: input.actorUserId,
        now: input.now,
        lineId: null,
      });
      await upsertPairingDecisionRow(tx, {
        productKey: input.productKey,
        status: "manual",
        url: input.url,
        actorUserId: input.actorUserId,
        now: input.now,
      });
      return "ok";
    }

    // "unavailable" | "discontinued" | "split" — žiadna URL, žiadny
    // link-override zápis (issue 399: split's per-veľkosť linky žijú v
    // `pairingVariantLinks`, zapísané samostatne cez `variant-links.ts`).
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.key, input.productKey)).limit(1);
    if (product === undefined) return "not_found";

    await upsertPairingDecisionRow(tx, {
      productKey: input.productKey,
      status: input.status,
      url: null,
      actorUserId: input.actorUserId,
      now: input.now,
    });
    return "ok";
  });
}
