import { expect, type Locator } from "@playwright/test";

// issue 593 (Štěpán; ROZHODNUTÉ majiteľa 5. 10. 2026 — auto-grow): pole na
// písanie v Poznámkach aj v Objednávkach predajňa (zdieľaná trieda
// `.write-field` + hook `useAutoGrowTextarea`) — prázdne ~3 riadky, pri
// písaní/Enter/vložení rastie PRESNE na obsah (nič skryté), strop `50vh`, nad
// ním sa POSÚVA a posledný riadok je dosiahnuteľný. Tento helper overuje tie
// vlastnosti v reálnom prehliadači (Chromium = CSS `field-sizing`, Firefox = JS
// fallback) na ľubovoľnom zo štyroch polí.

export interface FieldMetrics {
  lineHeight: number;
  contentHeight: number;
  clientHeight: number;
  offsetHeight: number;
  scrollHeight: number;
  overflowY: string;
  halfViewport: number;
  fieldSizing: string;
}

// Výška riadku sa MERIA (div s tým istým písmom: 2 riadky − 1 riadok), nie
// číta z `getComputedStyle().lineHeight` — floor-note polia majú písmo
// prehliadača s `line-height: normal`, ktoré sa ako číslo prečítať nedá.
export async function fieldMetrics(field: Locator): Promise<FieldMetrics> {
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
      offsetHeight: el.offsetHeight,
      scrollHeight: el.scrollHeight,
      overflowY: cs.overflowY,
      halfViewport: window.innerHeight / 2,
      fieldSizing: cs.getPropertyValue("field-sizing") || "nepodporované",
    };
  });
}

export function lines(n: number, prefix = "riadok"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${String(i + 1)}`).join("\n");
}

// `clientHeight`/`scrollHeight` sú celé čísla (zaokrúhlené), výška riadku
// zlomková — 2px tolerancia je len zaokrúhlenie, nie povolenie iného počtu
// riadkov (jeden riadok má 15-20px).
const ROUNDING_PX = 2;

/** Prázdne pole má ~3 riadky (nie menej, nie výrazne viac). */
export async function expectEmptyAboutThreeLines(field: Locator): Promise<FieldMetrics> {
  await expect(field).toHaveValue("");
  const m = await fieldMetrics(field);
  expect(m.lineHeight).toBeGreaterThan(0);
  expect(Math.abs(m.contentHeight - 3 * m.lineHeight)).toBeLessThanOrEqual(ROUNDING_PX);
  expect(m.overflowY).toBe("auto");
  return m;
}

/** Celý obsah je vidno: pole nemá čo posúvať (žiadny skrytý text). */
export async function expectNothingHidden(field: Locator): Promise<FieldMetrics> {
  const m = await fieldMetrics(field);
  expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
  return m;
}

/**
 * Do PRÁZDNEHO poľa napíše 6 riadkov skutočnými klávesmi (`newlineKey` —
 * Enter, alebo Shift+Enter tam, kde Enter ukladá) a overí, že pole narástlo
 * na obsah: aspoň 6 riadkov vysoké a nič skryté.
 */
export async function expectGrowsWhileTyping(field: Locator, newlineKey: "Enter" | "Shift+Enter"): Promise<FieldMetrics> {
  const empty = await fieldMetrics(field);
  await field.focus();
  for (let i = 1; i <= 6; i++) {
    await field.pressSequentially(`riadok ${String(i)}`);
    if (i < 6) await field.press(newlineKey);
  }
  await expect(field).toHaveValue(lines(6));
  const grown = await expectNothingHidden(field);
  expect(grown.clientHeight).toBeGreaterThan(empty.clientHeight);
  expect(grown.contentHeight + ROUNDING_PX).toBeGreaterThanOrEqual(6 * grown.lineHeight);
  return grown;
}

/**
 * 60 riadkov (vloženie celého textu naraz): výška zastropená na `50vh`, pole
 * sa dá posúvať (`overflow-y: auto`) a posunutím na koniec je vidno posledný
 * riadok.
 */
export async function expectCappedAndScrollable(field: Locator): Promise<FieldMetrics> {
  await field.fill(lines(60));
  const m = await fieldMetrics(field);
  expect(m.overflowY).toBe("auto");
  expect(Math.abs(m.offsetHeight - m.halfViewport)).toBeLessThanOrEqual(ROUNDING_PX);
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
  const bottom = await field.evaluate((node) => {
    const el = node as HTMLTextAreaElement;
    el.scrollTop = el.scrollHeight;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
  expect(bottom.scrollTop).toBeGreaterThan(0);
  expect(bottom.scrollTop + bottom.clientHeight).toBeGreaterThanOrEqual(bottom.scrollHeight - 1);
  return m;
}
