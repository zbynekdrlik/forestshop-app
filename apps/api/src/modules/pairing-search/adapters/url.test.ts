import { describe, expect, it } from "vitest";
import { belongsToBase, resolveAndStripFragment, resolveImageUrl } from "./url.js";

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

// issue 397 (mimo doslovného portu — port starej appka's `_IMG_NOISE`,
// `webreview/app.py`) — zdieľaná pomôcka pre všetky tri adaptéry aj
// `verify.ts`'s `og:image` fallback.
describe("resolveImageUrl", () => {
  it("resolves the FIRST non-empty candidate and stops (never checks later ones)", () => {
    expect(resolveImageUrl(["/a.jpg", "/b.jpg"], "https://www.wetland.sk")).toBe("https://www.wetland.sk/a.jpg");
  });

  it("skips undefined/empty candidates and falls through to the next", () => {
    expect(resolveImageUrl([undefined, "", "  ", "/b.jpg"], "https://www.wetland.sk")).toBe("https://www.wetland.sk/b.jpg");
  });

  it("returns null when every candidate is undefined/empty", () => {
    expect(resolveImageUrl([undefined, ""], "https://www.wetland.sk")).toBeNull();
  });

  it("returns null when every candidate is unresolvable (malformed URL)", () => {
    expect(resolveImageUrl(["http://["], "https://www.wetland.sk")).toBeNull();
  });

  it("filters out a noise marker (logo/placeholder/…) and falls through to the next candidate", () => {
    expect(resolveImageUrl(["/logo.png", "/product.jpg"], "https://www.wetland.sk")).toBe("https://www.wetland.sk/product.jpg");
  });

  it.each(["logo", "/producer/", ".svg", "/svg/", "placeholder", "no-image", "banner", "/img/m/"])(
    "filters a candidate whose resolved URL contains the noise marker %j",
    (marker) => {
      expect(resolveImageUrl([`/${marker}/x.jpg`], "https://www.wetland.sk")).toBeNull();
    },
  );

  it("noise matching is case-insensitive", () => {
    expect(resolveImageUrl(["/LOGO/x.jpg"], "https://www.wetland.sk")).toBeNull();
  });

  it("trims whitespace before resolving", () => {
    expect(resolveImageUrl(["  /a.jpg  "], "https://www.wetland.sk")).toBe("https://www.wetland.sk/a.jpg");
  });

  // Review nález, issue 397: rezolvovaná URL sa priamo ukladá do DB a
  // renderuje do `<img src>` na prihlásenej review obrazovke — len
  // `http:`/`https:` je platný scheme, aj keď je inak nespracovateľný.
  it("rejects a non-http(s) scheme (e.g. data:) and falls through to the next candidate", () => {
    expect(resolveImageUrl(["data:image/png;base64,AAAA", "/product.jpg"], "https://www.wetland.sk")).toBe(
      "https://www.wetland.sk/product.jpg",
    );
  });

  it("returns null when the ONLY candidate is a non-http(s) scheme", () => {
    expect(resolveImageUrl(["javascript:alert(1)"], "https://www.wetland.sk")).toBeNull();
  });
});
