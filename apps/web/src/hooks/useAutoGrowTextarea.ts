import { useLayoutEffect, type RefObject } from "react";
import { autoResizeTextarea } from "../autoResizeTextarea.js";

// issue 593: pole na písanie (Poznámky + Objednávky predajňa, CSS `.write-field`)
// rastie PRESNE na obsah. Prehliadač s `field-sizing: content` (Chromium,
// Firefox 153+) to robí sám v CSS; prehliadač bez neho (starší Firefox/Safari)
// potrebuje JS fallback cez `autoResizeTextarea`. Hook ho spúšťa:
// - pri KAŽDEJ zmene hodnoty (písanie, Enter, vloženie, emoji, ale aj
//   vyprázdnenie po uložení → pole sa vráti na `rows={3}`),
// - pri pripojení poľa a pri zmene `resetKey` (otvorenie úpravy dlhého textu,
//   aj prepnutie úpravy na inú poznámku s rovnakým textom = nový element) —
//   predtým sa výška menila len v `onChange`, takže pri otvorení ostal text
//   skrytý pod `overflow: hidden`,
// - pri zmene ŠÍRKY poľa (`ResizeObserver` — okno aj zbalenie bočného panela;
//   text sa inak zalomí inak a výška by nesedela).
// `active` = pole je práve zobrazené (úprava otvorená); keď nie, nič nerobí.
// Prázdne pole na OBOCH cestách zruší inline výšku — aj výšku po ručnom
// ťahaní úchytom (`resize: vertical`), ktorú by `field-sizing` inak držal.

export function supportsFieldSizing(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
}

// Prázdne pole NEMERIA `scrollHeight` — Chromium/WebKit doň rátajú aj
// zalomený placeholder (na 375px by prázdne pole malo 5 riadkov namiesto 3);
// inline výška sa zruší a výšku dá `rows={3}` + CSS `min-height`.
function fit(el: HTMLTextAreaElement): void {
  if (el.value === "") {
    el.style.height = "";
    return;
  }
  autoResizeTextarea(el);
}

export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, active = true, resetKey: unknown = null): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null) return;
    if (value === "") {
      el.style.height = "";
      return;
    }
    if (!supportsFieldSizing()) fit(el);
  }, [ref, value, active, resetKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null || supportsFieldSizing()) return;
    let lastWidth: number | null = null;
    let frame = 0;
    // Prepočet až v ďalšej snímke — zmena výšky priamo v callbacku by
    // vyvolala „ResizeObserver loop completed…" chybu v konzole.
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? null;
      if (width === lastWidth) return;
      const first = lastWidth === null;
      lastWidth = width;
      if (first) return; // úvodné hlásenie pri observe — výšku už nastavil efekt vyššie
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fit(el);
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, active, resetKey]);
}
