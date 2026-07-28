import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("heslá", () => {
  it("overí správne heslo", async () => {
    const hash = await hashPassword("tajneheslo123");
    await expect(verifyPassword(hash, "tajneheslo123")).resolves.toBe(true);
  });

  it("odmietne nesprávne heslo", async () => {
    const hash = await hashPassword("tajneheslo123");
    await expect(verifyPassword(hash, "ineheslo")).resolves.toBe(false);
  });

  it("dva hashe toho istého hesla sa líšia (soľ)", async () => {
    expect(await hashPassword("rovnake")).not.toBe(await hashPassword("rovnake"));
  });
});
