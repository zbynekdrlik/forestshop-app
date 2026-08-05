import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_DOMENY_EMAIL = "e2e-domeny@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// issue 227: prehľad podľa domény + vylúčenie vlastného e-shopu. Seedovaná
// v `scripts/e2e-setup.ts`: `virginiashop.sk` má DVA `supplier_stock` riadky
// (jeden čitateľný, jeden `unknown`), tretí produkt má odkaz na
// `www.forestshop.sk` (náš vlastný e-shop, nikdy sa nezapisuje do
// `supplier_stock` — počíta sa živo z `internalNote`).
test("prehľad podľa domény ukáže virginiashop.sk aj upozornenie na vlastný e-shop; konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/");
  await page.getByLabel("E-mail").fill(E2E_DOMENY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();

  await page.getByRole("button", { name: "Dodávateľský sklad" }).click();
  await expect(page.getByRole("heading", { name: "Dodávateľský sklad" })).toBeVisible();

  const karta = page.getByTestId("ss-host-overview");
  await expect(karta).toBeVisible();
  // Stĺpce (`SupplierStockSection.tsx`): Doména/Odkazov/Číta sa/Neviem/Zlyhalo/…
  // — zámerne overené PO BUNKÁCH (nie len `toContainText` na celom riadku),
  // aby zhoda netrafila náhodou aj časovú pečiatku v poslednom stĺpci.
  const riadokDomeny = page.getByTestId("ss-host-virginiashop.sk");
  await expect(riadokDomeny).toBeVisible();
  const bunky = riadokDomeny.locator("td");
  await expect(bunky.nth(1)).toHaveText("2"); // odkazov spolu
  await expect(bunky.nth(2)).toHaveText("1"); // z toho čitateľných
  await expect(bunky.nth(3)).toHaveText("1"); // unknown

  // Vlastný e-shop sa nikdy nescrapuje, ale odkaz sa ukáže ako vylúčený.
  await expect(page.getByTestId("ss-own-shop-links")).toContainText("1");

  // forestshop.sk sa NESMIE objaviť medzi sledovanými doménami v prehľade.
  await expect(page.getByTestId("ss-host-forestshop.sk")).toHaveCount(0);

  expect(chyby).toEqual([]);
});
