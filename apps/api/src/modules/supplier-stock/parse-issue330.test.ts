// issue 330: doména BEZ akéhokoľvek pravidla (ani TEXT_AVAILABILITY_RULES,
// ani VISIBLE_AVAILABILITY_RULES — teda žiadna overovacia práca sa preň
// nikdy nespravila) nesmie dostať `available` len zo strojového JSON-LD/meta
// údaju bez druhej kontroly. Živý dôkaz: roy.sk (997/S543, restock_event
// 9. 8. 2026) sa prepol výhradne na `"https://schema.org/InStock"`, hoci
// roy.sk v žiadnom zo zoznamov v `availability-domain-rules.ts` nie je.
//
// Vlastný súbor (nie parse.test.ts), aby ani jeden zo súborov neprerástol
// eslint max-lines: 400 (`.claude/rules/testing.md`) — rovnaký vzor ako
// existujúci parse-issue307.test.ts split.
import { describe, expect, it } from "vitest";
import { parsePage } from "./parse.js";

const ROY_JSON_LD_INSTOCK = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Wachman Alfa",
 "offers":{"@type":"Offer","price":"49,90","priceCurrency":"EUR",
 "availability":"https://schema.org/InStock"}}
</script>
</head><body><p>Popis produktu.</p></body></html>`;

describe("parsePage — issue 330: doména bez akéhokoľvek pravidla nikdy neprepne na 'available' zo samotného JSON-LD", () => {
  it("roy.sk s JSON-LD 'InStock' je unknown, NIKDY available (žiadna druhá kontrola pre túto doménu neexistuje)", () => {
    const result = parsePage(ROY_JSON_LD_INSTOCK, "https://www.roy.sk/p-3238/wachman-alfa");
    expect(result.availability).toBe("unknown");
    expect(result.availability).not.toBe("available");
    expect(result.source).toBe("none");
  });

  it("rovnaký JSON-LD 'OutOfStock' na doméne bez pravidla sa BERIE ako doteraz (unavailable nikdy neprepne skladom, nič sa nemení)", () => {
    const html = ROY_JSON_LD_INSTOCK.replace("InStock", "OutOfStock");
    const result = parsePage(html, "https://www.roy.sk/p-3238/wachman-alfa");
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("json_ld");
  });

  it("rovnaký JSON-LD 'InStock' na doméne S OVERENÝM pravidlom (huntingshop.eu) ostáva available bez zmeny — existujúce domény sa touto opravou nedotýkajú", () => {
    const result = parsePage(ROY_JSON_LD_INSTOCK, "https://www.huntingshop.eu/p/1");
    expect(result.availability).toBe("available");
    expect(result.source).toBe("json_ld");
  });

  it("meta znacky (product:availability) na doméne bez pravidla su rovnako fail-closed, nikdy sa neprepnu na available", () => {
    const html = `<meta property="product:availability" content="instock"><body>Popis</body>`;
    const result = parsePage(html, "https://www.roy.sk/p-9999/nieco");
    expect(result.availability).toBe("unknown");
    expect(result.source).toBe("none");
  });
});
