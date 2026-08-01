import { describe, expect, it } from "vitest";
import { shoptetImportConfigFromBaseUrl } from "./config.js";

describe("shoptetImportConfigFromBaseUrl", () => {
  it("builds the three Shoptet admin URLs from the bare origin", () => {
    const cfg = shoptetImportConfigFromBaseUrl("https://www.forestshop.sk", "u", "p");
    expect(cfg.loginUrl).toBe("https://www.forestshop.sk/admin/");
    expect(cfg.importUrl).toBe("https://www.forestshop.sk/admin/import-produktov/");
    expect(cfg.logUrl).toBe("https://www.forestshop.sk/admin/import-produktov/log/");
    expect(cfg.user).toBe("u");
    expect(cfg.password).toBe("p");
  });

  it("tolerates a trailing slash on the base URL", () => {
    const cfg = shoptetImportConfigFromBaseUrl("https://www.forestshop.sk/", "u", "p");
    expect(cfg.loginUrl).toBe("https://www.forestshop.sk/admin/");
  });
});
