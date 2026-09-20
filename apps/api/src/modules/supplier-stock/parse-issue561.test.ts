// Predfilter enumeračných cieľov na NAŠE veľkosti — issue 561 (follow-up #552).
// Enumerácia (#552) sťahovala KAŽDÚ veľkosť z dodávateľovho <select>u, aj tie,
// ktoré vôbec nemáme (wetland: 1440 z 1752 requestov = 82 %, nočný beh 122 min
// nad stropom 2 h). `selectEnumerationTargets` ponechá len ciele, ktoré sa
// spárujú na niektorú našu veľkosť (alebo na niektorý token viactokenovej našej
// veľkosti — párový štítok "39-40" potrebuje ciele "39" aj "40", inak by
// `foldMultiTokenSizeAvailability` vrátil `unknown`). Žiadna zhoda → všetky
// ciele (fail-open na sťahovanie, nie na správnosť — riadky sa aj tak zapíšu
// cez `matchSizeLabel`). Čistá funkcia, testovaná bez DB (vlastný súbor,
// eslint max-lines 400).
import { describe, expect, it } from "vitest";
import { selectEnumerationTargets } from "./parse.js";
import type { CombinationTarget } from "./parse.js";

const target = (label: string): CombinationTarget => ({ url: `https://www.wetland.sk/p?label=${label}`, label });

const labelsOf = (targets: readonly CombinationTarget[]): string[] => targets.map((t) => t.label);

describe("selectEnumerationTargets — issue 561: predfilter na naše veľkosti", () => {
  it("naše [M, L] vs ciele XS..3XL → ponechá len M a L (2 ciele)", () => {
    const targets = ["XS", "S", "M", "L", "XL", "XXL", "3XL"].map(target);
    const kept = selectEnumerationTargets(targets, ["M", "L"]);
    expect(labelsOf(kept)).toEqual(["M", "L"]);
  });

  it("párový štítok '39-40' vs jednotlivé čísla dodávateľa → ponechá ciele 39 AJ 40 (token match)", () => {
    const targets = ["38", "39", "40", "41", "42"].map(target);
    const kept = selectEnumerationTargets(targets, ["39-40"]);
    expect(labelsOf(kept).sort()).toEqual(["39", "40"]);
  });

  it("žiadna zhoda (naše veľkosti dodávateľ nemá) → ponechá VŠETKY ciele (fail-open)", () => {
    const targets = ["48", "50", "52"].map(target);
    const kept = selectEnumerationTargets(targets, ["99", "XXL"]);
    expect(labelsOf(kept)).toEqual(["48", "50", "52"]);
  });

  it("prázdny zoznam cieľov → prázdny (jednoveľkostný produkt, enumerácia sa preskočí)", () => {
    expect(selectEnumerationTargets([], ["M", "L"])).toEqual([]);
  });

  it("jednotokenová naša veľkosť sa NEPÁRUJE na dodávateľov párový štítok (rôzny počet tokenov) — rovnaká disciplína ako matchSizeLabel", () => {
    // "L" (1 token) vs "L/XL" (2 tokeny): riadok pre "L" by bol `unknown` aj pri
    // stiahnutí (matchSizeLabel žiada rovnaký počet častí), takže cieľ netreba.
    const targets = [target("L/XL"), target("M")].map((t) => t);
    const kept = selectEnumerationTargets(targets, ["M"]);
    expect(labelsOf(kept)).toEqual(["M"]);
  });
});
