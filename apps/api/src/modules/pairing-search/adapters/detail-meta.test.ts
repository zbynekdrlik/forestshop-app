import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBetalovDetailMeta } from "./betalov.js";
import { jsonLdSupplierDetailMeta } from "./detail-meta.js";
import { odimonAdapter } from "./odimon.js";
import { wetlandAdapter } from "./wetland.js";

// issue 422 — testy proti orezaným fixtúram zo živo overených reálnych
// stránok (`design komentár na tickete`, 13. 8. 2026) — rovnaký vzor ako
// `verify.test.ts`.

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

describe("jsonLdSupplierDetailMeta — WETLAND/ODIMON zdieľaný JSON-LD Offer helper", () => {
  it("WETLAND: price z Offer, availability BackOrder -> 'Nedostupné'", () => {
    const meta = jsonLdSupplierDetailMeta(fixture("wetland-detail-cena-dostupnost.html"));
    expect(meta.price).toBe("149.90");
    expect(meta.availabilityText).toBe("Nedostupné");
  });

  it("ODIMON: price z Offer, availability InStock -> 'Skladom'", () => {
    const meta = jsonLdSupplierDetailMeta(fixture("odimon-detail-cena-dostupnost.html"));
    expect(meta.price).toBe("78.90");
    expect(meta.availabilityText).toBe("Skladom");
  });

  it("žiadne JSON-LD na stránke -> price/availabilityText obe null, nikdy nevyhodí", () => {
    const meta = jsonLdSupplierDetailMeta("<html><body>bez JSON-LD</body></html>");
    expect(meta).toEqual({ price: null, availabilityText: null });
  });

  it("wetlandAdapter/odimonAdapter's extractDetailMeta dáva ROVNAKÝ výsledok ako zdieľaný helper priamo (dokazuje, že sú zapojené na TÚ ISTÚ funkciu)", () => {
    const html = fixture("wetland-detail-cena-dostupnost.html");
    expect(wetlandAdapter.extractDetailMeta(html)).toEqual(jsonLdSupplierDetailMeta(html));
    expect(odimonAdapter.extractDetailMeta(html)).toEqual(jsonLdSupplierDetailMeta(html));
  });
});

describe("parseBetalovDetailMeta — huntingshop.eu's var prodData extrakcia", () => {
  it("prodData JS premenná: price + is_item_in_stock=1 -> 'Skladom'", () => {
    const meta = parseBetalovDetailMeta(fixture("betalov-detail-cena-dostupnost.html"));
    expect(meta.price).toBe("36.50");
    expect(meta.availabilityText).toBe("Skladom");
  });

  it("is_item_in_stock=0 -> 'Nedostupné'", () => {
    const html = `<script>var prodData = {"price": 12.5, "is_item_in_stock": 0};</script>`;
    expect(parseBetalovDetailMeta(html)).toEqual({ price: "12.50", availabilityText: "Nedostupné" });
  });

  it("žiadna prodData premenná na stránke -> price/availabilityText obe null", () => {
    expect(parseBetalovDetailMeta("<html><body>bez prodData</body></html>")).toEqual({ price: null, availabilityText: null });
  });

  it("nevalidný JSON v prodData (drift markupu) -> nikdy nevyhodí, degraduje na null/null", () => {
    const html = `<script>var prodData = {toto nie je platný JSON};</script>`;
    expect(parseBetalovDetailMeta(html)).toEqual({ price: null, availabilityText: null });
  });

  it("chýbajúce/neplatné price pole -> price null, availabilityText sa napriek tomu vyparsuje", () => {
    const html = `<script>var prodData = {"is_item_in_stock": 1};</script>`;
    expect(parseBetalovDetailMeta(html)).toEqual({ price: null, availabilityText: "Skladom" });
  });
});
