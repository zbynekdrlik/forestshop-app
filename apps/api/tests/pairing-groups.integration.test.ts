import { expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { users } from "../src/db/schema.js";

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

// Issue 47 (F4 rozdelenie podľa veľkostí) — `GET /api/pairing` teraz posiela
// AJ `productKey`/`productName` na KAŽDOM riadku, aby si frontend vedel
// zoskupiť plochý zoznam variantov podľa produktu (`apps/web/src/
// pairingGroups.ts`). Toto sú JEDINÉ dve nové polia, ktoré táto úloha do
// odpovede pridáva — samotné zoskupenie a "rozdelené"/"nerozdelené" je
// odvodené len na frontende, žiadna nová DB migrácia.
it("GET /api/pairing posiela productKey/productName rovnaké pre všetky varianty toho istého produktu", async () => {
  const ctx = await withCleanDb();
  try {
    await ctx.db.insert(users).values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: "manazer",
    });
    const app = createApp(ctx.db, { cookieSecure: false });
    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    await insertTestVariantForProduct(ctx.db, "40260", "40260/M", {
      sizeLabel: "M",
      productName: "Bunda FOREST",
    });
    await insertTestVariantForProduct(ctx.db, "40260", "40260/L", {
      sizeLabel: "L",
      productName: "Bunda FOREST",
    });
    // Kontrolná skupina — INÝ produkt, aby test overil, že sa produkty
    // nezmiešajú (rôzny `productKey` musí zostať rôzny).
    await insertTestVariantForProduct(ctx.db, "40261", "40261/M", {
      sizeLabel: "M",
      productName: "Vesta FOREST",
    });

    const res = await app.request("/api/pairing?pageSize=200", { headers: { cookie } });
    expect(res.status).toBe(200);
    const telo = (await res.json()) as {
      total: number;
      items: readonly { variantCode: string; productKey: string; productName: string }[];
    };
    expect(telo.total).toBe(3);

    const bunda = telo.items.filter((i) => i.variantCode.startsWith("40260/"));
    expect(bunda).toHaveLength(2);
    for (const item of bunda) {
      expect(item.productKey).toBe("40260");
      expect(item.productName).toBe("Bunda FOREST");
    }

    const vesta = telo.items.find((i) => i.variantCode === "40261/M");
    expect(vesta).toMatchObject({ productKey: "40261", productName: "Vesta FOREST" });
  } finally {
    await ctx.close();
  }
});
