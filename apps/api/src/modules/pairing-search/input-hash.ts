// issue 387 E3: detekcia zastarania kandidátov — "input_hash (hash mena +
// external kódov — detekcia zastarania)" (návrh, sekcia "DB schéma"). Čistá
// funkcia (žiadna DB/sieť) — `select.ts` ju volá pre KAŽDÝ produkt a
// porovnáva s `pairing_candidate_set.input_hash` uloženým z posledného
// gather behu; rozdielna hodnota = katalógový import zmenil meno/kódy
// odvtedy, produkt je znova eligible aj keď kandidátov už má.

import { createHash } from "node:crypto";
import type { PairingProduct } from "./types.js";

/**
 * Stabilný hash produktu pre detekciu zastarania. `externalCodes` sa
 * zoraďuje pred hashovaním (`toPairingProduct` už zachováva poradie prvého
 * výskytu — dva behy s TÝMI ISTÝMI kódmi, ale iným poradím variantov v DB
 * dopyte, by inak dali RÔZNY hash pre ROVNAKÝ obsah, čo by spôsobilo
 * zbytočný re-gather).
 */
export function computeInputHash(product: PairingProduct): string {
  const payload = JSON.stringify({
    name: product.name,
    externalCodes: [...product.externalCodes].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
}
