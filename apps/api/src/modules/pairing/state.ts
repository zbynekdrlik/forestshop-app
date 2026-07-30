import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairings, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";

export type ConfirmPairingResult = "ok" | "not_found" | "missing_url";

export interface ConfirmPairingInput {
  readonly variantCode: string;
  // Voliteľné — keď je prítomné, PREPÍŠE navrhnutú/uloženú adresu pred
  // potvrdením (stará appka's "zamietni a zadaj inú adresu ručne"). Keď
  // chýba, potvrdí sa AKTUÁLNE uložená adresa (stará appka's "✓ jedným
  // klikom") — viď návrhový komentár na issue 45.
  readonly supplierUrl?: string | undefined;
  readonly actorUserId: string;
  readonly now: Date;
}

// Celý zápis beží v JEDNEJ transakcii (rovnaký vzor ako `orders/state.ts`'s
// `setOrderLineState` a `orders/supplier-contact.ts`'s
// `setSupplierContactEmail`) — nový stav bez auditového záznamu (alebo
// naopak) by nechal históriu ("kto a kedy potvrdil párovanie") nekonzistentnú
// so skutočným obsahom riadku.
export async function confirmPairing(db: Database, input: ConfirmPairingInput): Promise<ConfirmPairingResult> {
  return db.transaction(async (tx) => {
    const [variant] = await tx
      .select({ code: variants.code })
      .from(variants)
      .where(eq(variants.code, input.variantCode))
      .limit(1);
    if (variant === undefined) return "not_found";

    // `.for("update")` na existujúcom `pairing` riadku (ak existuje) —
    // rovnaký dôvod ako `setOrderLineState`'s zámok (nález review na #25 v
    // tomto repe): bez neho by dve súbežné potvrdenia TOHO ISTÉHO variantu
    // mohli obe prečítať tú istú (čoskoro zastaranú) uloženú adresu pred
    // tým, než druhá transakcia commitne svoj UPSERT. Zámok drží riadok len
    // do konca TEJTO transakcie.
    const [existing] = await tx
      .select({ supplierUrl: pairings.supplierUrl })
      .from(pairings)
      .where(eq(pairings.variantCode, input.variantCode))
      .for("update")
      .limit(1);

    const manualOverride = input.supplierUrl !== undefined;
    const finalUrl = manualOverride ? input.supplierUrl : (existing?.supplierUrl ?? null);
    if (finalUrl === null || finalUrl === "") return "missing_url";

    // Upsert — funguje rovnako, či `pairing` riadok pre tento variant už
    // existuje (typicky po #46 auto-návrhu), alebo ešte vôbec neexistuje
    // (dnešný bežný prípad, kým #46 nepristane) — `variant_code` UNIQUE
    // (schema-pairing.ts) robí z tohto bezpečný atomický upsert.
    await tx
      .insert(pairings)
      .values({
        variantCode: input.variantCode,
        supplierUrl: finalUrl,
        state: "potvrdene",
        confirmedBy: input.actorUserId,
        confirmedAt: input.now,
      })
      .onConflictDoUpdate({
        target: pairings.variantCode,
        set: {
          supplierUrl: finalUrl,
          state: "potvrdene",
          confirmedBy: input.actorUserId,
          confirmedAt: input.now,
        },
      });

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "pairing.confirm",
      entity: "pairing",
      entityId: input.variantCode,
      data: { variantCode: input.variantCode, supplierUrl: finalUrl, manualOverride },
    });

    return "ok";
  });
}
