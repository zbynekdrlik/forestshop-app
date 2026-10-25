// issue 598: JEDINÝ vstup na forestshop.sk pre HTTP fetchery appky (sitemap,
// sonda kandidátov, feed pre porovnávače, export katalógu, exporty
// objednávok). Robí dve veci, ktoré musia byť rovnaké všade:
//
// 1. bloková stránka Shoptetu (403 + „Access temporarily blocked“, `blocked.ts`)
//    → `ShoptetBlockedError` so zrozumiteľnou správou `shoptet_blocked: …`,
//    nikdy „HTTP 403" ani tiché `null`;
// 2. započíta požiadavku do počítadla aktuálneho behu (`request-tally.ts`) →
//    `job_run.detail.shoptetRequests`.
//
// URL sa NIKDY neloguje — exporty nesú prihlasovací údaj v query (`hash=`),
// do logu ide len `context` od volajúceho (napr. „export objednávok").

import { readBounded } from "../../read-bounded.js";
import { log } from "../../logger.js";
import { isShoptetBlockPage, ShoptetBlockedError } from "./blocked.js";
import { noteShoptetRequest } from "./request-tally.js";

// Bloková stránka má ~6 kB. Strop chráni pamäť pred nepriateľskou/pokazenou 403
// odpoveďou — rovnaký princíp ako `readBounded` všade inde v appke.
const MAX_BLOCK_PAGE_BYTES = 256 * 1024;

async function readBlockCandidate(response: Response): Promise<string> {
  try {
    const body = await readBounded(response.clone(), MAX_BLOCK_PAGE_BYTES);
    return body.toString("utf8");
  } catch (error) {
    // Telo 403 sa nedá prečítať (prekročený strop / prerušené spojenie) — nie je
    // to dôkaz bloku; volajúci dostane pôvodnú 403 a spracuje ju ako bežnú chybu.
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.warn({ rawErrorMessage }, "shoptet-http: telo 403 odpovede sa nedalo prečítať na kontrolu bloku");
    return "";
  }
}

export async function shoptetFetch(url: string, init: RequestInit, context: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // Aj neúspešný pokus (timeout, sieť) je požiadavka, ktorá na e-shop odišla.
    noteShoptetRequest(false);
    throw error;
  }
  const blocked = response.status === 403 && isShoptetBlockPage(403, await readBlockCandidate(response));
  noteShoptetRequest(blocked);
  if (blocked) {
    log.warn({ context, status: response.status }, "shoptet-http: Shoptet vrátil blokovú stránku (IP servera dočasne zablokovaná)");
    throw new ShoptetBlockedError(context);
  }
  return response;
}
