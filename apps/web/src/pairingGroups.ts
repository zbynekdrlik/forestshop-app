import { PairingUnauthorizedError, type PairingItem } from "./pairingApi.js";

/**
 * Zoskupenie plochého zoznamu variantov (`GET /api/pairing`) podľa produktu
 * (issue 47, F4 rozdelenie podľa veľkostí) — čisto ODVODENÉ z aktuálnych
 * dát, nikdy nepersistuje "split" rozhodnutie (viď návrhový komentár na
 * issue 47): produkt so ZHODNOU `supplierUrl` naprieč všetkými svojimi
 * variantmi sa zobrazí ako JEDEN zbalený riadok (bulk akcie na všetky
 * veľkosti naraz); akonáhle sa adresy variantov reálne LÍŠIA, je produkt
 * "efektívne rozdelený" a zobrazí sa (alebo zostáva zobrazený) po
 * veľkostiach — presne ako dnešný plochý zoznam pred touto zmenou.
 */
export interface ProductGroup {
  readonly productKey: string;
  readonly productName: string;
  readonly variants: readonly PairingItem[];
}

/**
 * Zoskupí PODĽA PRODUKTU, v poradí PRVÉHO výskytu produktu v pôvodnom
 * (server-triedenom podľa `variant.code`) zozname — takže varianty toho
 * istého produktu, aj keby v abecednom triedení neboli súvislé, skončia v
 * JEDNEJ skupine na svojom prvom mieste výskytu.
 */
export function groupPairingItems(items: readonly PairingItem[]): readonly ProductGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PairingItem[]>();
  for (const item of items) {
    const existing = byKey.get(item.productKey);
    if (existing === undefined) {
      order.push(item.productKey);
      byKey.set(item.productKey, [item]);
    } else {
      existing.push(item);
    }
  }
  return order.map((productKey) => {
    const variants = byKey.get(productKey) ?? [];
    return { productKey, productName: variants[0]?.productName ?? "", variants };
  });
}

/**
 * `true`, keď VŠETKY varianty produktu majú PRESNE rovnakú `supplierUrl`
 * (vrátane "všetky null") — jediný prípad, kedy dáva zmysel zobraziť ich
 * ako JEDEN zbalený riadok s JEDNÝM poľom na adresu.
 */
export function isGroupHomogeneous(group: ProductGroup): boolean {
  const [first, ...rest] = group.variants;
  if (first === undefined) return true;
  return rest.every((v) => v.supplierUrl === first.supplierUrl);
}

/** `true`, keď je KAŽDÝ variant produktu potvrdený. */
export function isGroupFullyConfirmed(group: ProductGroup): boolean {
  return group.variants.length > 0 && group.variants.every((v) => v.state === "potvrdene");
}

/**
 * Kto/kedy potvrdil skupinu — len keď je KAŽDÝ variant potvrdený TOU ISTOU
 * osobou v ten istý čas (bežný prípad po bulk potvrdení). Inak `null`, aby
 * zbalený riadok nikdy nepredstieral jednotnú atribúciu, ktorá v skutočnosti
 * je zmiešaná — podrobnosti sú vždy dostupné po rozdelení na veľkosti.
 */
export function groupConfirmation(group: ProductGroup): {
  readonly confirmedByName: string | null;
  readonly confirmedAt: string | null;
} {
  const [first, ...rest] = group.variants;
  if (first === undefined || first.confirmedByName === null) return { confirmedByName: null, confirmedAt: null };
  const same = rest.every(
    (v) => v.confirmedByName === first.confirmedByName && v.confirmedAt === first.confirmedAt,
  );
  return same ? { confirmedByName: first.confirmedByName, confirmedAt: first.confirmedAt } : { confirmedByName: null, confirmedAt: null };
}

/**
 * Overí výsledky bulk potvrdenia (jeden `POST /api/pairing/confirm` na
 * KAŽDÝ variant kód skupiny, volané paralelne cez `Promise.allSettled` —
 * žiadny nový backend endpoint, `confirmPairing` je už bezpečný idempotentný
 * upsert per variant). Pri ČIASTOČNOM zlyhaní (niektoré varianty prešli,
 * iné nie) hlási počet zlyhaných; pri `PairingUnauthorizedError`
 * PREHODÍ TÚ ISTÚ inštanciu (nikdy nezabalenú), aby komponent stále vedel
 * rozoznať vypršanú reláciu od bežnej chyby.
 */
export function assertBulkConfirmSucceeded(
  variantCodes: readonly string[],
  results: readonly PromiseSettledResult<void>[],
): void {
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === 0) return;
  // `PromiseRejectedResult.reason` je v TS libe typované ako `any` — explicitné
  // `unknown` tu zabraňuje `@typescript-eslint/no-unsafe-assignment` a núti
  // ďalej pracovať len cez `instanceof` zúženie (rovnaký vzor ako
  // `pairingApi.ts`'s `catch (err: unknown)`).
  const first: unknown = failed[0]?.reason;
  if (first instanceof PairingUnauthorizedError) throw first;
  const message = first instanceof Error ? first.message : "Uloženie adresy sa nepodarilo.";
  throw new Error(
    failed.length === variantCodes.length
      ? message
      : `${message} (zlyhalo ${String(failed.length)} z ${String(variantCodes.length)} veľkostí)`,
  );
}
