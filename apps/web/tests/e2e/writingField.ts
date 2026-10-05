import { expect, type Locator } from "@playwright/test";

// issue 593 (Štěpán): pole na písanie v Poznámkach aj v Objednávkach predajňa
// má byť prázdne vysoké aspoň 5 riadkov a pri dlhšom texte sa má dať POSÚVAŤ
// (predtým floor-note polia mali `overflow: hidden` — text navyše nebolo
// vidno). Zdieľané pravidlo `.write-field` v `app.css` — tento helper overuje
// OBE vlastnosti v reálnom prehliadači na ľubovoľnom z tých štyroch polí.

interface FieldMetrics {
  lineHeight: number;
  contentHeight: number;
  clientHeight: number;
  scrollHeight: number;
  overflowY: string;
}

// Výška riadku sa MERIA (div s tým istým písmom: 2 riadky − 1 riadok), nie
// číta z `getComputedStyle().lineHeight` — floor-note polia majú písmo
// prehliadača s `line-height: normal`, ktoré sa ako číslo prečítať nedá.
async function metrics(field: Locator): Promise<FieldMetrics> {
  return field.evaluate((node) => {
    const el = node as HTMLTextAreaElement;
    const cs = getComputedStyle(el);
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.lineHeight = cs.lineHeight;
    document.body.append(probe);
    probe.textContent = "x";
    const one = probe.getBoundingClientRect().height;
    probe.textContent = "x\nx";
    const two = probe.getBoundingClientRect().height;
    probe.remove();
    const padY = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    return {
      lineHeight: two - one,
      contentHeight: el.clientHeight - padY,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: cs.overflowY,
    };
  });
}

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `riadok ${String(i + 1)}`).join("\n");
}

// `clientHeight` je celé číslo (zaokrúhlené), výška riadku zlomková — 1px
// tolerancia je len zaokrúhlenie, nie povolenie menšieho poľa.
const ROUNDING_PX = 1;

/**
 * Overí pole na písanie: (1) PRÁZDNE je aspoň 5 riadkov vysoké, (2) pri 8
 * riadkoch nemá zbytočný posuvník (rastúce pole sa zväčší, pevné posúva
 * prirodzene), (3) pri 20 riadkoch je výška zastropená (~15 riadkov), dá sa
 * posúvať (`overflow-y: auto`, `scrollHeight > clientHeight`) a posunutím na
 * koniec je vidno posledný riadok. Pole na konci VYPRÁZDNI (nič neuloží —
 * volajúci rozhodne, či úpravu zruší).
 */
export async function expectWritingField(field: Locator, opts: { grows: boolean }): Promise<FieldMetrics> {
  await field.fill("");
  const empty = await metrics(field);
  expect(empty.lineHeight).toBeGreaterThan(0);
  expect(empty.contentHeight + ROUNDING_PX).toBeGreaterThanOrEqual(5 * empty.lineHeight);
  expect(empty.overflowY).toBe("auto");

  if (opts.grows) {
    // Rastúce pole (autoResizeTextarea) pod stropom nesmie ukazovať posuvník —
    // výška musí zahŕňať aj rámik, inak chýbajú 2px a posuvník bliká.
    await field.fill(lines(8));
    const mid = await metrics(field);
    expect(mid.scrollHeight).toBeLessThanOrEqual(mid.clientHeight);
  }

  await field.fill(lines(20));
  const full = await metrics(field);
  expect(full.overflowY).toBe("auto");
  expect(full.scrollHeight).toBeGreaterThan(full.clientHeight);
  expect(full.contentHeight).toBeLessThanOrEqual(15 * full.lineHeight + ROUNDING_PX);
  const bottom = await field.evaluate((node) => {
    const el = node as HTMLTextAreaElement;
    el.scrollTop = el.scrollHeight;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
  expect(bottom.scrollTop).toBeGreaterThan(0);
  expect(bottom.scrollTop + bottom.clientHeight).toBeGreaterThanOrEqual(bottom.scrollHeight - ROUNDING_PX);

  await field.fill("");
  return empty;
}
