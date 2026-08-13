import { useEffect, useState } from "react";
import { EMPTY_LIVE_SUPPLIER_INFO, fetchLiveSupplierInfo, type LiveSupplierInfo } from "./pairingReviewApi.js";

// issue 422 — lazy live-info fetch pre kartu (navrhnutý kandidát) aj panel
// (top-8 riadky), volaný pri mounte inštancie (rovnaký zámer ako stará
// appky's `IntersectionObserver`-riadený lazy fetch — `.claude/rules/
// pairing-search.md`'s issue 397 sekcia, "Populácia je INNER JOIN ...";
// mount ≈ viditeľné v DOM-e, keďže táto obrazovka stránkuje po 50, nikdy
// nerenderuje tisíce kariet naraz ako stará appka).
//
// Concurrency-cap 4 (rovnaký princíp ako stará appky's `IMG_FETCH_CONCURRENCY
// = 4`, `webreview/static/app.js`) — MODUL-LEVEL fronta zdieľaná NAPRIEČ
// všetkými inštanciami tohto hooku na stránke, aby otvorenie stránky s N
// napárovanými kartami naraz nespustilo N súbežných fetchov na dodávateľov.

const CONCURRENCY = 4;
let active = 0;
const queue: (() => void)[] = [];

function pump(): void {
  while (active < CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    if (task === undefined) break;
    active += 1;
    task();
  }
}

function schedule(task: () => Promise<void>): void {
  queue.push(() => {
    task()
      .catch(() => undefined) // fetchLiveSupplierInfo sama nikdy nevyhodí — obranná vrstva navyše
      .finally(() => {
        active -= 1;
        pump();
      });
  });
  pump();
}

export function useLiveSupplierInfo(url: string | null): LiveSupplierInfo {
  const [info, setInfo] = useState<LiveSupplierInfo>(EMPTY_LIVE_SUPPLIER_INFO);

  useEffect(() => {
    if (url === null) {
      setInfo(EMPTY_LIVE_SUPPLIER_INFO);
      return;
    }
    let cancelled = false;
    setInfo(EMPTY_LIVE_SUPPLIER_INFO);
    schedule(async () => {
      const result = await fetchLiveSupplierInfo(url);
      if (!cancelled) setInfo(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return info;
}
