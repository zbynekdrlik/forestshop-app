import { useLayoutEffect, type RefObject } from "react";
import { autoResizeTextarea } from "../autoResizeTextarea.js";

// issue 593: pole na písanie (Poznámky + Objednávky predajňa, CSS `.write-field`)
// rastie PRESNE na obsah. Prehliadač s `field-sizing: content` (Chromium) to
// robí sám v CSS; ostatné (Firefox — Štěpánov prehliadač) potrebujú JS
// fallback cez `autoResizeTextarea`. Hook ho spúšťa:
// - pri KAŽDEJ zmene hodnoty (písanie, Enter, vloženie, emoji, ale aj
//   vyprázdnenie po uložení → pole sa vráti na `rows={3}`),
// - pri pripojení poľa (otvorenie úpravy dlhého textu má hneď celú výšku —
//   predtým sa výška menila len v `onChange`, takže pri otvorení ostal text
//   skrytý pod `overflow: hidden`),
// - pri zmene šírky okna (text sa inak zalomí a výška by nesedela).
// `active` = pole je práve zobrazené (úprava otvorená); keď nie, nič nerobí.

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

export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, active = true): void {
  useLayoutEffect(() => {
    if (!active || supportsFieldSizing()) return;
    const el = ref.current;
    if (el) fit(el);
  }, [ref, value, active]);

  useLayoutEffect(() => {
    if (!active || supportsFieldSizing()) return;
    const onResize = (): void => {
      if (ref.current) fit(ref.current);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [ref, active]);
}
