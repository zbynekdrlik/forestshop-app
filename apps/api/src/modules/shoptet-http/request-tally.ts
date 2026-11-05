// issue 598: koľko požiadaviek poslal JEDEN beh úlohy na forestshop.sk — aby
// bolo v `job_run.detail` vidno, kto e-shop zaťažuje (Shoptet WAF od 21. 10.
// 2026 blokuje IP servera). `AsyncLocalStorage` namiesto prevliekania
// počítadla cez signatúry každého fetchera: scheduler (`scheduler.ts`'s
// `executeJob`) aj `startRunNow` obalia `run()` jedným `runWithShoptetRequestTally`
// a `shoptetFetch` (`fetch.ts`) si aktuálne počítadlo nájde sám. Súbežné behy
// (napr. naplánovaný import + ručné „Spustiť teraz") majú každý svoje.

import { AsyncLocalStorage } from "node:async_hooks";

export interface ShoptetRequestTally {
  /** HTTP požiadavky na e-shop cez `shoptetFetch` (aj zablokované). */
  requests: number;
  /** Z nich bloková stránka Shoptetu. */
  blocked: number;
  /** Playwright relácie do administrácie (prihlásenie + niekoľko stránok, v dieťa procese — jednotlivé požiadavky prehliadača sa nepočítajú). */
  adminSessions: number;
}

const storage = new AsyncLocalStorage<ShoptetRequestTally>();

export function newShoptetRequestTally(): ShoptetRequestTally {
  return { requests: 0, blocked: 0, adminSessions: 0 };
}

export function runWithShoptetRequestTally<T>(tally: ShoptetRequestTally, fn: () => Promise<T>): Promise<T> {
  return storage.run(tally, fn);
}

export function noteShoptetRequest(blocked: boolean): void {
  const tally = storage.getStore();
  if (tally === undefined) return;
  tally.requests += 1;
  if (blocked) tally.blocked += 1;
}

export function noteShoptetAdminSession(): void {
  const tally = storage.getStore();
  if (tally === undefined) return;
  tally.adminSessions += 1;
}

/**
 * Pridá nenulové počty k `job_run.detail`. Prázdne počítadlo detail NEMENÍ
 * (úloha, čo na e-shop nechodí, má detail presne ako doteraz). Objektový
 * detail dostane polia navyše (UI Zod schémy neznáme kľúče strippujú), `null`/
 * `undefined` sa nahradí samotnými počtami, pole/primitív sa zabalí do `result`.
 */
export function attachShoptetRequestTally(detail: unknown, tally: ShoptetRequestTally): unknown {
  const counts: Record<string, number> = {};
  if (tally.requests > 0) counts["shoptetRequests"] = tally.requests;
  if (tally.blocked > 0) counts["shoptetBlocked"] = tally.blocked;
  if (tally.adminSessions > 0) counts["shoptetAdminSessions"] = tally.adminSessions;
  if (Object.keys(counts).length === 0) return detail ?? null;
  if (detail === null || detail === undefined) return counts;
  if (typeof detail === "object" && !Array.isArray(detail)) return { ...(detail as Record<string, unknown>), ...counts };
  return { result: detail, ...counts };
}
