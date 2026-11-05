// issue 598: spoločná ochranná pauza po bloku Shoptetu. Bez nej počas bloku
// chodili na forestshop.sk ďalej všetky úlohy (orders-import každých 15 min,
// katalóg, restock), čo blok mohlo predlžovať. Po skutočnej blokovej stránke
// nejde 60 min na e-shop žiadna požiadavka ani Playwright relácia. Pauzu
// nastaví iba SKUTOČNÁ odpoveď Shoptetu, odmietnutie počas pauzy ju nepredĺži,
// takže prvá úloha po uplynutí pauzy zistí, či blok ešte trvá.
//
// Stav je zámerne len v pamäti procesu: reštart stojí najviac jednu požiadavku
// navyše a tá pauzu hneď obnoví.

import { isShoptetBlockedError, ShoptetBlockedError } from "./blocked.js";

export const SHOPTET_BLOCK_BACKOFF_MS = 60 * 60 * 1000;

let backoffUntilMs: number | null = null;

export function noteShoptetBlocked(): void {
  backoffUntilMs = Date.now() + SHOPTET_BLOCK_BACKOFF_MS;
}

export function isShoptetBackoffActive(): boolean {
  return backoffUntilMs !== null && Date.now() < backoffUntilMs;
}

/** Iba pre testy: stav žije v module, testy v jednom súbore by sa ovplyvňovali. */
export function resetShoptetBackoff(): void {
  backoffUntilMs = null;
}

export function backoffRejection(context: string): ShoptetBlockedError {
  return new ShoptetBlockedError(`${context}; požiadavka sa neposlala, beží ochranná pauza po bloku`);
}

/**
 * Obal okolo Playwright relácie do administrácie. Relácia beží v dieťa procese,
 * ktorý pauzu nevidí, preto ju stráži a nastavuje rodič.
 */
export async function guardShoptetAdminSession<T>(context: string, run: () => Promise<T>): Promise<T> {
  if (isShoptetBackoffActive()) throw backoffRejection(context);
  try {
    return await run();
  } catch (error) {
    if (isShoptetBlockedError(error)) noteShoptetBlocked();
    throw error;
  }
}
