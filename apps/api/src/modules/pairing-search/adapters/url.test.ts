import { describe, expect, it } from "vitest";
import { belongsToBase, resolveAndStripFragment } from "./url.js";

describe("resolveAndStripFragment", () => {
  it("resolves a relative href against the base and strips the fragment", () => {
    expect(resolveAndStripFragment("/nohavice/x#/9-velkost-48", "https://www.wetland.sk")).toBe(
      "https://www.wetland.sk/nohavice/x",
    );
  });

  it("leaves an already-absolute href untouched apart from the fragment", () => {
    expect(resolveAndStripFragment("https://www.wetland.sk/x#frag", "https://www.wetland.sk")).toBe(
      "https://www.wetland.sk/x",
    );
  });

  it("returns null (never throws) for a malformed href — WHATWG URL is stricter than Python's urljoin", () => {
    // Review finding, issue 387 E2: WHATWG `URL` rejects this (unlike
    // Python's lenient urljoin/urldefrag) — a caller that let this throw
    // would abort its whole .each() loop and lose every other candidate.
    expect(resolveAndStripFragment("http://[", "https://www.wetland.sk")).toBeNull();
  });
});

describe("belongsToBase", () => {
  it("accepts a URL under the base path", () => {
    expect(belongsToBase("https://www.wetland.sk/x", "https://www.wetland.sk")).toBe(true);
  });

  it("accepts the bare base URL itself", () => {
    expect(belongsToBase("https://www.wetland.sk", "https://www.wetland.sk")).toBe(true);
  });

  it("rejects a different domain that merely shares the base as a string prefix", () => {
    // Review finding, issue 387 E2: a bare startsWith (the literal port of
    // Python's `url.startswith(base_url)`) would wrongly accept this.
    expect(belongsToBase("https://www.wetland.sk.evil.example/x", "https://www.wetland.sk")).toBe(false);
  });

  it("rejects an unrelated host", () => {
    expect(belongsToBase("https://evil.example/x", "https://www.wetland.sk")).toBe(false);
  });
});
