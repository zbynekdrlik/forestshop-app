import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

// issue 469: `GOOGLE_CALENDAR_ICS_URL` prijme VIAC tajných iCal adries oddelených
// čiarkou alebo novým riadkom (spätne kompatibilné s jednou adresou). Každá
// položka sa validuje ako URL; chybová hláška NIKDY neobsahuje samotnú adresu
// (tajný token je v ceste — `.claude/rules/calendar.md`). Testy používajú
// výhradne falošné `.invalid` adresy, nikdy skutočnú Google adresu.
const BASE = { DATABASE_URL: "postgres://u:p@localhost:5432/db" } as NodeJS.ProcessEnv;

describe("loadEnv — GOOGLE_CALENDAR_ICS_URL viac adries (issue 469)", () => {
  it("nenastavená premenná → undefined (karta sa nezobrazí, fail-graceful)", () => {
    expect(loadEnv({ ...BASE }).GOOGLE_CALENDAR_ICS_URL).toBeUndefined();
  });

  it("jedna URL → 1-prvkové pole (spätná kompatibilita)", () => {
    const env = loadEnv({ ...BASE, GOOGLE_CALENDAR_ICS_URL: "https://cal.example.invalid/private-a/basic.ics" });
    expect(env.GOOGLE_CALENDAR_ICS_URL).toEqual(["https://cal.example.invalid/private-a/basic.ics"]);
  });

  it("viac URL oddelených čiarkou → pole všetkých", () => {
    const env = loadEnv({
      ...BASE,
      GOOGLE_CALENDAR_ICS_URL: "https://cal.example.invalid/a/basic.ics,https://cal.example.invalid/b/basic.ics",
    });
    expect(env.GOOGLE_CALENDAR_ICS_URL).toEqual([
      "https://cal.example.invalid/a/basic.ics",
      "https://cal.example.invalid/b/basic.ics",
    ]);
  });

  it("viac URL oddelených novým riadkom (a s okolitými medzerami) → pole orezaných URL", () => {
    const env = loadEnv({
      ...BASE,
      GOOGLE_CALENDAR_ICS_URL: " https://cal.example.invalid/a/basic.ics \n https://cal.example.invalid/b/basic.ics ",
    });
    expect(env.GOOGLE_CALENDAR_ICS_URL).toEqual([
      "https://cal.example.invalid/a/basic.ics",
      "https://cal.example.invalid/b/basic.ics",
    ]);
  });

  it("neplatná položka → loadEnv nahlas zlyhá a chybová hláška NEOBSAHUJE žiadnu adresu", () => {
    let message = "";
    try {
      loadEnv({
        ...BASE,
        GOOGLE_CALENDAR_ICS_URL: "https://cal.example.invalid/a/basic.ics,nie-je-url-tajne-xyz",
      });
      throw new Error("malo zlyhať, ale nezlyhalo");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/GOOGLE_CALENDAR_ICS_URL/);
    // Tajná adresa (ani jej cesta) sa do hlášky nikdy nevypíše.
    expect(message).not.toMatch(/nie-je-url-tajne-xyz/);
    expect(message).not.toMatch(/basic\.ics/);
  });
});
