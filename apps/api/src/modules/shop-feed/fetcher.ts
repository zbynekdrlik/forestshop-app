// Sťahovanie feedu pre porovnávače (issue 220).
//
// Adresa je verejná a nenesie prihlasovací údaj, takže sa — na rozdiel od
// `catalog/fetcher.ts` — nič neprekrýva. Ohraničené čítanie tela sa ale
// PREBERÁ odtiaľ (`readBounded`): strop musí platiť POČAS čítania, nie až po
// zbufferovaní celého tela, inak by pokazený server vyčerpal pamäť kontajnera
// skôr, než sa strop stihne skontrolovať.

import { readBounded } from "../catalog/fetcher.js";
import { MAX_FEED_BYTES, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { ShopFeedFetcher } from "./run.js";

export function createHttpShopFeedFetcher(url: string): ShopFeedFetcher {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Feed ${url} vrátil HTTP ${String(response.status)}`);
      }
      const body = await readBounded(response, MAX_FEED_BYTES);
      return body.toString("utf8");
    } finally {
      clearTimeout(timer);
    }
  };
}
