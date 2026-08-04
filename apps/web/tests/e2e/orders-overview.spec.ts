import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_PREHLAD_EMAIL = "e2e-prehlad@forestshop.sk";

interface RawOrderLine {
  readonly orderId: string;
  readonly ordered: boolean;
  readonly state: "objednane" | "caka_sa" | "skladom" | "nedostupne";
  readonly placedAt: string;
}
interface RawSupplierGroup {
  readonly lines: readonly RawOrderLine[];
}

// issue 237: blok dlaždíc nad zoznamom "Na objednanie" — "Prehľad e-shopu"
// (dnes/tento týždeň/tento mesiac) + "Súhrn o objednávaní". VLASTNÝ izolovaný
// účet (`scripts/e2e-setup.ts`'s komentár k `E2E_PREHLAD_EMAIL` — zdieľaný
// balík je už na hranici `MAX_ATTEMPTS`).
test("blok 'Prehľad e-shopu' + 'Súhrn o objednávaní' sa zobrazí a čísla zodpovedajú reálnym dátam z /api/orders/open, konzola je čistá", async ({
  page,
}) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=orders");
  await page.getByLabel("E-mail").fill(E2E_PREHLAD_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Na objednanie" })).toBeVisible();

  // "Prehľad e-shopu" — `scripts/e2e-setup.ts` seeduje PRESNE JEDNU objednávku
  // (externalOrderId "9009", ŽIADNY order_line) s `placedAt: teraz` a
  // `totalPriceWithVat: "77.50"` — jediná objednávka, ktorá je isto "dnes",
  // takže dlaždica DNES má DETERMINISTICKÉ, presne overiteľné číslo.
  const dnesDlazdica = page.getByTestId("overview-shop-today");
  await expect(dnesDlazdica).toBeVisible();
  await expect(dnesDlazdica).toContainText("1 objednávka");
  await expect(dnesDlazdica).toContainText("77.50 €");

  // Tento týždeň/mesiac VŽDY obsahuje aspoň dnešnú objednávku — presný počet
  // by závisel od toho, KEDY presne e2e beh prebehne voči ostatným
  // (staršie dátumované) seedovaným objednávkam, preto len dolná hranica.
  const tyzdenDlazdica = page.getByTestId("overview-shop-week");
  const mesiacDlazdica = page.getByTestId("overview-shop-month");
  // "objednáv" (spoločný prefix) namiesto presného tvaru — počet v týchto
  // dvoch dlaždiciach môže padnúť do ktoréhokoľvek z troch slovenských tvarov
  // (`formatOrderCount`: 1/2-4/5+), podľa toho, koľko ĎALŠÍCH seedovaných
  // objednávok práve v momente behu spadá do tohto týždňa/mesiaca.
  await expect(tyzdenDlazdica).toContainText(/\d+\s+objednáv/);
  await expect(mesiacDlazdica).toContainText(/\d+\s+objednáv/);

  // "Súhrn o objednávaní" — porovnané NEZÁVISLE vypočítanou hodnotou z
  // reálnych dát `/api/orders/open` (rovnaká autentifikovaná session, čo
  // appka sama načítava) — nie hardcoded číslo, ktoré by závisel od poradia
  // spustenia ostatných spec súborov v tom istom e2e behu.
  const { suppliers } = await page.evaluate(() =>
    fetch("/api/orders/open").then((r) => r.json() as Promise<{ suppliers: readonly RawSupplierGroup[] }>),
  );
  const allLines = suppliers.flatMap((g) => g.lines);
  const isResolved = (l: RawOrderLine): boolean => l.ordered || l.state !== "objednane";
  const nevybavene = allLines.filter((l) => !isResolved(l));
  const ocakavaneRemaining = nevybavene.length;
  const ocakavaneAffected = new Set(nevybavene.map((l) => l.orderId)).size;
  const ocakavaneOrdered = allLines.filter((l) => l.ordered).length;

  await expect(page.getByTestId("overview-ordering-remaining")).toContainText(String(ocakavaneRemaining));
  await expect(page.getByTestId("overview-ordering-affected-orders")).toContainText(String(ocakavaneAffected));
  await expect(page.getByTestId("overview-ordering-already-ordered")).toContainText(String(ocakavaneOrdered));

  // Seed dáta (`scripts/e2e-setup.ts`) vždy nechávajú aspoň jeden nevybavený
  // riadok, takže dlaždica "Najstaršia čakajúca" musí ukázať SKUTOČNÝ dátum
  // (obsahuje číslicu), nikdy zástupnú pomlčku.
  expect(ocakavaneRemaining).toBeGreaterThan(0);
  await expect(page.getByTestId("overview-ordering-oldest")).not.toHaveText("—");
  await expect(page.getByTestId("overview-ordering-oldest")).toContainText(/\d/);

  // Dlaždice sú PREHĽAD, nikdy filter — klik na "Súhrn o objednávaní" tlačidlá
  // (nie sú klikateľné vôbec) nemení obsah zoznamu; overuje sa tu jednoducho
  // tak, že blok nemá žiadny `<button>` element.
  await expect(page.getByTestId("orders-overview").locator("button")).toHaveCount(0);

  expect(chyby).toEqual([]);
});
