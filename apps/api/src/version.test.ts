import { describe, expect, it } from "vitest";
import { appVersion } from "./version.js";

describe("appVersion", () => {
  it("vráti verziu v tvare semver", () => {
    expect(appVersion().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("vráti commit, aj keď env premenná chýba", () => {
    delete process.env["APP_COMMIT"];
    expect(appVersion().commit).toBe("unknown");
  });
});
