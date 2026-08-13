import { asc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingVariantLinks, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";

// issue 399 — per-VEĽKOSŤ manuálny override odkazu na dodávateľa (karta's
// "✂ Rozdeliť na veľkosti"). ÚPLNE nezávislý zápis od `decisions.ts`'s
// `setPairingDecision` (žiadna zdieľaná transakcia — každý riadok sa uloží
// SAMOSTATNE, presne ako stará appka's `saveVariantLink` per-riadok save,
// design komentár na tickete).

export interface PairingVariantLinkRow {
  readonly code: string;
  readonly sizeLabel: string | null;
  readonly url: string | null;
}

// Zoznam variantov produktu s ich AKTUÁLNYM per-veľkosť linkom (`null` = appka
// ešte nič nevie). Zoradené podľa `sizeLabel` (prázdne/`null` naposledy),
// potom podľa `code` — stabilné, čitateľné poradie na paneli.
export async function listPairingVariantLinks(db: Database, productKey: string): Promise<readonly PairingVariantLinkRow[]> {
  const rows = await db
    .select({ code: variants.code, sizeLabel: variants.sizeLabel, url: pairingVariantLinks.url })
    .from(variants)
    .leftJoin(pairingVariantLinks, eq(pairingVariantLinks.code, variants.code))
    .where(eq(variants.productKey, productKey))
    .orderBy(asc(variants.code));

  return rows
    .slice()
    .sort((a, b) => {
      const aLabel = a.sizeLabel ?? "";
      const bLabel = b.sizeLabel ?? "";
      if (aLabel === "" && bLabel !== "") return 1;
      if (bLabel === "" && aLabel !== "") return -1;
      if (aLabel !== bLabel) return aLabel.localeCompare(bLabel, "sk");
      return a.code.localeCompare(b.code, "sk");
    })
    .map((r) => ({ code: r.code, sizeLabel: r.sizeLabel, url: r.url }));
}

export type SetPairingVariantLinkResult = "ok" | "not_found";

export interface SetPairingVariantLinkInput {
  readonly productKey: string;
  readonly code: string;
  /** `null`/prázdne = vymazať (DELETE riadku, nikdy `url = null` — schéma to ani nedovolí). */
  readonly url: string | null;
  readonly actorUserId: string;
  readonly now: Date;
}

// `code` MUSÍ patriť `productKey` — bez tejto kontroly by omylom (alebo
// zlomyseľne) poslaný cudzí kód zapísal link pod NESÚVISIACI variant iného
// produktu. `not_found` pokrýva OBA prípady (kód neexistuje AJ kód patrí
// inému produktu) — rovnaká disciplína ako `pairing-routes.ts`'s
// `variantCode` telo-parameter kontrola (`.claude/rules/pairing.md`).
export async function setPairingVariantLink(db: Database, input: SetPairingVariantLinkInput): Promise<SetPairingVariantLinkResult> {
  return db.transaction(async (tx) => {
    const [variant] = await tx.select({ productKey: variants.productKey }).from(variants).where(eq(variants.code, input.code)).limit(1);
    if (variant === undefined || variant.productKey !== input.productKey) return "not_found";

    const [previous] = await tx.select({ url: pairingVariantLinks.url }).from(pairingVariantLinks).where(eq(pairingVariantLinks.code, input.code)).limit(1);

    const trimmed = input.url?.trim() ?? "";
    if (trimmed === "") {
      // Idempotentné vymazanie — kód bez riadku (dvojklik/žiadna zmena) je
      // no-op ok, žiadny audit záznam (rovnaký princíp ako
      // `setPairingDecision`'s "revert" no-op vetva).
      if (previous === undefined) return "ok";

      await tx.delete(pairingVariantLinks).where(eq(pairingVariantLinks.code, input.code));
      await record(tx, {
        at: input.now,
        actorUserId: input.actorUserId,
        action: "pairing_variant_link.cleared",
        entity: "pairing_variant_link",
        entityId: input.code,
        data: { productKey: input.productKey, code: input.code, previousUrl: previous.url },
      });
      return "ok";
    }

    await tx
      .insert(pairingVariantLinks)
      .values({ code: input.code, url: trimmed, updatedAt: input.now })
      .onConflictDoUpdate({ target: pairingVariantLinks.code, set: { url: trimmed, updatedAt: input.now } });

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "pairing_variant_link.changed",
      entity: "pairing_variant_link",
      entityId: input.code,
      data: { productKey: input.productKey, code: input.code, previousUrl: previous?.url ?? null, newUrl: trimmed },
    });
    return "ok";
  });
}
