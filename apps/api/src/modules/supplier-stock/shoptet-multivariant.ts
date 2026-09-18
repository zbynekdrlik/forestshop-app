// Generické Shoptet VIACVARIANTOVÉ (viac-veľkostné) pravidlo dostupnosti — issue 558.
//
// Jednovariantová Shoptet stránka nesie súhrnný `<span data-testid="labelAvailability">`
// (číta ho `shoptetLabelAvailability`, TEXT pravidlo). VIACVARIANTOVÁ stránka ho VÔBEC
// nevykresľuje — namiesto toho nesie dostupnosť KAŽDEJ kombinácie v skrytom
// `<span class="parameter-dependent no-display <kľúč>">` (JS ich prepína). `<kľúč>` je
// postupnosť párov `<paramId>-<valueId>` (napr. `22-181-4-3-5-8` = délka(22)=181,
// barva(4)=3, velikost(5)=8) — VEĽKOSTNÝ pár je ten s `data-parameter-id` veľkostného
// `<select data-parameter-name="Velikost|Veľkosť">`.
//
// Sila signálu (živý nález 2026-09-18, luko.cz produkt 102131): číslo kusov
// (`numberAvailabilityAmount` „(N ks)") NIE JE spoľahlivé — vypredaná veľkosť 47 mala
// label „Vyprodáno" (#cb0000) a NAPRIEK tomu „(3 ks)". Preto rozhoduje LABEL ako
// HARD-NEGATIVE: label „Vyprodáno"/„Nedostupné" → unavailable AJ pri kladnom čísle;
// inak `(N ks)` ≥ 1 → available, `0` → unavailable; ak číslo chýba (zubicek.cz nemá
// `numberAvailabilityAmount`), rozhodne samotný label (Skladem → available). To zodpovedá
// dizajnu (Prístup 1) — len s explicitným poradím label-pred-číslom.
//
// Tá istá veľkosť sa môže vyskytnúť VO VIACERÝCH kombináciách (rôzne farby/dĺžky) — náš
// `variant.size_label` farbu nenesie, takže sa dedupuje podľa veľkosti: zhodná
// dostupnosť → jedna položka, ROZPORNÁ → veľkosť sa ZAHODÍ (fail-closed, rovnaká
// disciplína ako `mergeSizeAvailability`/`matchSizeLabel`). Generické — ďalšia Shoptet
// doména so živo overeným vypredaným protipólom sa pridá len zápisom hosta v `parse.ts`.

import { availabilityFromText, isSizeParamName, type SupplierAvailability } from "./availability-primitives.js";

/** Jedna veľkosť dodávateľa (rovnaký tvar ako `SizeAvailability` v `parse.ts` —
 * štruktúrne kompatibilný, aby ho `SIZE_AVAILABILITY_RULES.read` prijal bez cyklu). */
interface ShoptetSize {
  readonly sizeLabel: string;
  readonly availability: "available" | "unavailable";
}

/** Normalizuje názov parametra na porovnanie bez diakritiky/veľkosti písmen. */
function normalizeParamName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** Očisti HTML fragment na holý text. */
function stripToText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

interface SizeParam {
  readonly paramId: string;
  /** `valueId` → text veľkosti (napr. „38"). */
  readonly options: ReadonlyMap<string, string>;
}

/** Nájde VEĽKOSTNÝ `<select>` (názov OBSAHUJE veľkostný výraz — issue 566, napr.
 * „Velikost", „Veľkosť", „Veľkosť PONOŽKY") — jeho `data-parameter-id` a mapu
 * `option value` → text. `null` = žiadny (jednovariantová stránka, alebo produkt
 * bez veľkostného parametra, alebo len ne-veľkostný parameter ako „Optické zvětšení"). */
function findSizeParam(html: string): SizeParam | null {
  for (const selectMatch of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = selectMatch[1] ?? "";
    const paramId = /data-parameter-id="(\d+)"/i.exec(attrs)?.[1];
    const paramName = /data-parameter-name="([^"]*)"/i.exec(attrs)?.[1];
    if (paramId === undefined || paramName === undefined) continue;
    if (!isSizeParamName(normalizeParamName(paramName))) continue;
    const options = new Map<string, string>();
    for (const optionMatch of (selectMatch[2] ?? "").matchAll(/<option\b[^>]*\bvalue="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi)) {
      const text = stripToText(optionMatch[2] ?? "");
      if (text !== "") options.set(optionMatch[1] ?? "", text);
    }
    if (options.size > 0) return { paramId, options };
  }
  return null;
}

/** Z kľúča `parameter-dependent` spanu (`22-181-4-3-5-8`) vytiahne `valueId`
 * VEĽKOSTNÉHO parametra — kľúč sú páry `<paramId>-<valueId>` zľava. `null` keď
 * kľúč veľkostný parameter nenesie (napr. default-variant). */
function sizeValueFromKey(key: string, sizeParamId: string): string | null {
  const parts = key.split("-");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === sizeParamId) return parts[i + 1] ?? null;
  }
  return null;
}

/** Dostupnosť JEDNEJ kombinácie z výrezu za jej `parameter-dependent` spanom.
 * LABEL má prednosť (hard-negative), inak `(N ks)`, inak samotný label. */
function variantAvailability(region: string): SupplierAvailability {
  const labelMatch = /<span\b[^>]*class="[^"]*availability-label[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(region);
  const labelAvailability = labelMatch === null ? "unknown" : availabilityFromText(stripToText(labelMatch[1] ?? "")).availability;
  if (labelAvailability === "unavailable") return "unavailable";
  const amountMatch = /numberAvailabilityAmount"[^>]*>([\s\S]*?)<\/span>/i.exec(region);
  if (amountMatch !== null) {
    const digits = (amountMatch[1] ?? "").replace(/[^0-9]/g, "");
    if (digits !== "") return Number(digits) >= 1 ? "available" : "unavailable";
  }
  return labelAvailability === "available" ? "available" : "unknown";
}

/**
 * Zoznam veľkostí a ich dostupnosti z viacvariantovej Shoptet stránky. Prázdny
 * zoznam (jednovariantová stránka bez veľkostného selectu, alebo žiadna
 * rozhodnuteľná veľkosť) → `parseSizeAvailability` vráti `null` → `run.ts` padne
 * na blanket (jednovariant → `shoptetLabelAvailability` TEXT pravidlo, nezmenené).
 */
export function shoptetMultiVariantSizeList(html: string): readonly ShoptetSize[] {
  const sizeParam = findSizeParam(html);
  if (sizeParam === null) return [];
  const opens = [...html.matchAll(/<span\b[^>]*class="([^"]*\bparameter-dependent\b[^"]*)"[^>]*>/gi)];
  // `null` = veľkosť videná s ROZPORNOU dostupnosťou (zahodí sa, fail-closed).
  const byLabel = new Map<string, ShoptetSize | null>();
  for (let i = 0; i < opens.length; i += 1) {
    const open = opens[i];
    if (open?.index === undefined) continue;
    const keyToken = (open[1] ?? "").split(/\s+/).find((token) => /^\d+(?:-\d+)+$/.test(token));
    if (keyToken === undefined) continue;
    const valueId = sizeValueFromKey(keyToken, sizeParam.paramId);
    if (valueId === null) continue;
    const sizeLabel = sizeParam.options.get(valueId);
    if (sizeLabel === undefined) continue;
    const regionStart = open.index + open[0].length;
    const regionEnd = opens[i + 1]?.index ?? html.length;
    const availability = variantAvailability(html.slice(regionStart, regionEnd));
    if (availability === "unknown") continue;
    const existing = byLabel.get(sizeLabel);
    if (existing === undefined) byLabel.set(sizeLabel, { sizeLabel, availability });
    else if (existing !== null && existing.availability !== availability) byLabel.set(sizeLabel, null);
  }
  const result: ShoptetSize[] = [];
  for (const value of byLabel.values()) {
    if (value !== null) result.push(value);
  }
  return result;
}
