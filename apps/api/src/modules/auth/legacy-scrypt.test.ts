import { describe, expect, it } from "vitest";
import {
  createLegacyScryptHash,
  isLegacyScryptHash,
  parseLegacyScryptHash,
  verifyLegacyScryptPassword,
} from "./legacy-scrypt.js";

// Vymyslený reťazec v TVARE, aký píše werkzeug — slúži len na test
// rozoberania parametrov, nie na overenie hesla (na to sú testy nižšie, ktoré
// si odtlačok vyrobia samy). Zámerne tu nie je nič skutočné (#189).
const WERKZEUG_SHAPE = `scrypt:32768:8:1$Lu6GkbqAyGkKZfPB$${"ab12cd34".repeat(16)}`;

describe("staré scrypt odtlačky zo starej appky", () => {
  it("rozpozná werkzeug tvar", () => {
    expect(isLegacyScryptHash(WERKZEUG_SHAPE)).toBe(true);
    expect(isLegacyScryptHash("$argon2id$v=19$m=19456,t=2,p=1$c29s$aGFzaA")).toBe(false);
  });

  it("rozoberie parametre werkzeug tvaru", () => {
    const parsed = parseLegacyScryptHash(WERKZEUG_SHAPE);
    expect(parsed).not.toBeNull();
    expect(parsed?.cost).toBe(32_768);
    expect(parsed?.blockSize).toBe(8);
    expect(parsed?.parallelization).toBe(1);
    expect(parsed?.salt).toBe("Lu6GkbqAyGkKZfPB");
  });

  it("overí správne heslo proti vlastnému odtlačku", async () => {
    const hash = await createLegacyScryptHash("stareheslo123");
    expect(isLegacyScryptHash(hash)).toBe(true);
    await expect(verifyLegacyScryptPassword(hash, "stareheslo123")).resolves.toBe(true);
  });

  it("odmietne nesprávne heslo", async () => {
    const hash = await createLegacyScryptHash("stareheslo123");
    await expect(verifyLegacyScryptPassword(hash, "ineheslo")).resolves.toBe(false);
  });

  it("odmietne poškodený odtlačok namiesto pádu", async () => {
    for (const broken of [
      "scrypt:32768:8:1$sol",
      "scrypt:32768:8$sol$00",
      "scrypt:0:8:1$sol$" + "0".repeat(128),
      "scrypt:32769:8:1$sol$" + "0".repeat(128),
      "scrypt:32768:8:1$$" + "0".repeat(128),
      "scrypt:32768:8:1$sol$" + "0".repeat(126),
      "scrypt:32768:8:1$sol$" + "z".repeat(128),
      "pbkdf2:32768:8:1$sol$" + "0".repeat(128),
    ]) {
      expect(parseLegacyScryptHash(broken)).toBeNull();
      await expect(verifyLegacyScryptPassword(broken, "cokolvek")).resolves.toBe(false);
    }
  });

  it("neprijme absurdne nákladné parametre z databázy", () => {
    expect(parseLegacyScryptHash(`scrypt:${String(1 << 21)}:8:1$sol$${"0".repeat(128)}`)).toBeNull();
    expect(parseLegacyScryptHash(`scrypt:32768:128:1$sol$${"0".repeat(128)}`)).toBeNull();
    expect(parseLegacyScryptHash(`scrypt:32768:8:99$sol$${"0".repeat(128)}`)).toBeNull();
  });
});
