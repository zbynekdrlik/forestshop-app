import { describe, expect, it } from "vitest";
import {
  checkLoginRateLimit,
  rateLimitEntryCountsForTest,
  resetLoginRateLimit,
} from "./login-rate-limit.js";

const BASE = new Date("2026-01-01T00:00:00.000Z");
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const IP_MAX_ATTEMPTS = 30;

describe("checkLoginRateLimit — strop na počet záznamov", () => {
  it("mapa nerastie nad strop, aj keď sa použijú tisíce rôznych (IP, e-mail) párov", () => {
    resetLoginRateLimit();
    const extra = 2_000;
    for (let i = 0; i < MAX_ENTRIES + extra; i++) {
      checkLoginRateLimit(`198.51.100.${i % 250}.${Math.floor(i / 250)}`, `pouzivatel-${i}@x.sk`, BASE);
    }
    const counts = rateLimitEntryCountsForTest();
    expect(counts.pair).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(counts.ip).toBeLessThanOrEqual(MAX_ENTRIES);
  });
});

describe("checkLoginRateLimit — limit na IP nezávislý od e-mailu", () => {
  it("sprejovanie mnohých rôznych e-mailov z JEDNEJ IP narazí na IP limit", () => {
    resetLoginRateLimit();
    const ip = "203.0.113.50";
    for (let i = 0; i < IP_MAX_ATTEMPTS; i++) {
      expect(checkLoginRateLimit(ip, `obeta-${i}@x.sk`, BASE)).toBe(true);
    }
    // (IP_MAX_ATTEMPTS + 1)-vy pokus, opäť s NOVÝM e-mailom — per-e-mail limit by
    // ho nezachytil (každý e-mail sa použil len raz), musí zasiahnuť IP limit.
    expect(checkLoginRateLimit(ip, `obeta-${IP_MAX_ATTEMPTS}@x.sk`, BASE)).toBe(false);
  });

  it("iná IP nie je ovplyvnená sprejovaním na prvej IP", () => {
    resetLoginRateLimit();
    const ip = "203.0.113.51";
    for (let i = 0; i < IP_MAX_ATTEMPTS + 5; i++) {
      checkLoginRateLimit(ip, `obeta-${i}@x.sk`, BASE);
    }
    expect(checkLoginRateLimit("203.0.113.52", "iny@x.sk", BASE)).toBe(true);
  });
});

describe("checkLoginRateLimit — existujúce vlastnosti zostávajú", () => {
  it("10 pokusov s tým istým (IP, e-mail) párom prejde, 11. je odmietnutý", () => {
    resetLoginRateLimit();
    const ip = "203.0.113.60";
    const email = "manazer@forestshop.sk";
    for (let i = 0; i < 10; i++) {
      expect(checkLoginRateLimit(ip, email, BASE)).toBe(true);
    }
    expect(checkLoginRateLimit(ip, email, BASE)).toBe(false);
  });

  it("záznamy vypršia — po uplynutí okna sa ten istý pár znova povolí", () => {
    resetLoginRateLimit();
    const ip = "203.0.113.61";
    const email = "manazer@forestshop.sk";
    for (let i = 0; i < 10; i++) {
      checkLoginRateLimit(ip, email, BASE);
    }
    expect(checkLoginRateLimit(ip, email, BASE)).toBe(false);

    const later = new Date(BASE.getTime() + WINDOW_MS + 1);
    expect(checkLoginRateLimit(ip, email, later)).toBe(true);
  });
});
