import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appVersion } from "./version.js";

describe("appVersion", () => {
  it("vráti presne verziu z KOREŇOVÉHO package.json (nie z apps/api/package.json)", () => {
    // Regresný test: apps/api/package.json má verziu "0.0.0", ktorá tiež
    // vyhovie semver regexu — bez porovnania s koreňovou hodnotou by test
    // prešiel aj keby appVersion() omylom čítala súbor z nesprávneho adresára.
    delete process.env["APP_VERSION"];
    const rootPkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(rootPkg.version).not.toBe("0.0.0");
    expect(appVersion().version).toBe(rootPkg.version);
  });

  it("vráti commit, aj keď env premenná chýba", () => {
    delete process.env["APP_COMMIT"];
    expect(appVersion().commit).toBe("unknown");
  });
});
