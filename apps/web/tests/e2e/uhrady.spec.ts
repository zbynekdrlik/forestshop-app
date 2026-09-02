import { expect, test } from "@playwright/test";

const E2E_HESLO = "e2e-test-heslo"; // účet existuje len v testovacej databáze
const E2E_UHRADY_EMAIL = "e2e-uhrady@forestshop.sk"; // musí sa zhodovať s hodnotou v scripts/e2e-setup.ts

// Malý, platný PNG (1×1 px, ~68 B — bezpečne nad spodným stropom 64 B) na
// upload cez `setInputFiles`. Prehliadač ho vykreslí ako thumbnail aj v
// lightboxe. Dva distinktné mená = dva samostatné skeny.
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngBuffer = Buffer.from(PNG_1X1_BASE64, "base64");
function pngFile(name: string) {
  return { name, mimeType: "image/png", buffer: pngBuffer };
}

// issue 543: "SLAVOSPORT → Úhrady". Reálny prehliadač cez celý cyklus:
// jednoriadková poznámka (Enter aj Pridať), upload DVOCH skenov, uloženie
// popisu (prežije reload = server ho uložil), lightbox (klik zväčší, Esc aj ✕
// zavrie), zmazanie skenu S POTVRDENÍM. Konzola musí zostať čistá
// (`.claude/rules/testing.md`). Účet má rolu "sef" — zdieľaná obrazovka bez
// role-gatingu. Test je SELF-CONTAINED a po sebe upratuje (skeny/poznámky sú
// zdieľané tabuľky, filtruje VLASTNÉ fixtúry, #480).
test("Úhrady: poznámky + upload 2 skenov + popis + lightbox + zmazanie s potvrdením — konzola je čistá", async ({ page }) => {
  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=uhrady");
  await page.getByLabel("E-mail").fill(E2E_UHRADY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Úhrady" })).toBeVisible();
  await expect(page.getByTestId("uhrady-notes-empty")).toBeVisible();
  await expect(page.getByTestId("uhrady-scans-empty")).toBeVisible();

  // --- Poznámky: pridať cez Enter aj cez Pridať, zoradené najnovšie hore ---
  const noteInput = page.getByTestId("uhrady-note-input");
  await noteInput.fill("Uhradiť Fomei FA");
  await noteInput.press("Enter");
  await expect(page.getByTestId("uhrady-notes-list").getByText("Uhradiť Fomei FA")).toBeVisible();
  await noteInput.fill("Zavolať do banky");
  await page.getByTestId("uhrady-note-add").click();
  const noteRows = page.locator(".uhrady-note-row");
  await expect(noteRows).toHaveCount(2);
  await expect(noteRows.nth(0)).toContainText("Zavolať do banky"); // najnovšia hore
  await expect(noteRows.nth(1)).toContainText("Uhradiť Fomei FA");
  // Autor pri riadku (seedovaný účet má displayName "E2E Šéf").
  await expect(noteRows.nth(0).locator(".uhrady-note-meta")).toContainText("E2E Šéf");

  // Zmazať jednu poznámku.
  await noteRows.filter({ hasText: "Zavolať do banky" }).getByRole("button", { name: /^Odstrániť poznámku/ }).click();
  await expect(page.locator(".uhrady-note-row")).toHaveCount(1);

  // --- Upload DVOCH skenov naraz (multiple) ---
  await page.getByTestId("uhrady-file-input").setInputFiles([pngFile("fa-1.png"), pngFile("fa-2.png")]);
  const cards = page.locator(".uhrady-scan-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("uhrady-scans-empty")).toHaveCount(0);

  // --- Uložiť popis na prvom skene (blur uloží) a overiť, že prežije reload ---
  const firstDesc = cards.nth(0).locator(".uhrady-desc-input");
  await firstDesc.fill("Fomei 250 €");
  await firstDesc.blur();
  // Reload = grid sa načíta zo servera; hodnota tam musí byť (server uložil).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Úhrady" })).toBeVisible();
  await expect(page.locator(".uhrady-scan-card")).toHaveCount(2);
  // Aspoň jeden popis nesie uloženú hodnotu (server ju uložil — prežila reload).
  const values = await page.locator(".uhrady-desc-input").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  expect(values).toContain("Fomei 250 €");

  // --- Lightbox: klik na thumbnail zväčší, Esc zavrie, znovu otvoriť a ✕ zavrie ---
  await page.locator(".uhrady-thumb-btn").first().click();
  await expect(page.getByTestId("uhrady-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("uhrady-lightbox")).toHaveCount(0);
  await page.locator(".uhrady-thumb-btn").first().click();
  await expect(page.getByTestId("uhrady-lightbox")).toBeVisible();
  await page.getByTestId("uhrady-lightbox-close").click();
  await expect(page.getByTestId("uhrady-lightbox")).toHaveCount(0);

  // --- Zmazanie skenu S POTVRDENÍM (upratanie): najprv sa pýta, potom zmaže ---
  const before = await page.locator(".uhrady-scan-card").count();
  await page.locator(".uhrady-scan-card").first().getByRole("button", { name: /^Odstrániť sken/ }).click();
  await expect(page.locator(".uhrady-scan-card").first().getByText("Zmazať?")).toBeVisible();
  await page.locator(".uhrady-scan-card").first().getByRole("button", { name: "Áno, zmazať" }).click();
  await expect(page.locator(".uhrady-scan-card")).toHaveCount(before - 1);

  // Upratať zvyšok — zmazať druhý sken aj poslednú poznámku.
  await page.locator(".uhrady-scan-card").first().getByRole("button", { name: /^Odstrániť sken/ }).click();
  await page.locator(".uhrady-scan-card").first().getByRole("button", { name: "Áno, zmazať" }).click();
  await expect(page.getByTestId("uhrady-scans-empty")).toBeVisible();
  await page.locator(".uhrady-note-row").first().getByRole("button", { name: /^Odstrániť poznámku/ }).click();
  await expect(page.getByTestId("uhrady-notes-empty")).toBeVisible();

  expect(chyby).toEqual([]);
});

// issue 543 (trieda chýb #538/540/541): na 390px viewporte s ROZBALENÝM
// sidebarom (250px, nie predvolený rail 72px) nesmie obrazovka Úhrady pretekať
// vodorovne — ani pridávací riadok poznámky, ani grid thumbnailov. Test vytvorí
// reálnu poznámku aj reálny sken PRED rozbalením sidebaru, potom overí
// `scrollWidth <= innerWidth`. Self-contained + upratuje.
test("Úhrady na mobile (390px) s rozbaleným sidebarom nepreteká vodorovne — konzola je čistá", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const chyby: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") chyby.push(m.text());
  });
  page.on("pageerror", (e) => {
    chyby.push(e.message);
  });

  await page.goto("/?tab=uhrady");
  await page.getByLabel("E-mail").fill(E2E_UHRADY_EMAIL);
  await page.getByLabel("Heslo").fill(E2E_HESLO);
  await page.getByRole("button", { name: "Prihlásiť sa" }).click();
  await expect(page.getByRole("heading", { name: "Úhrady" })).toBeVisible();

  // Reálna poznámka s dlhším textom + reálny sken (grid s thumbnailom).
  const noteInput = page.getByTestId("uhrady-note-input");
  await noteInput.fill("Skontrolovať a uhradiť všetky faktúry od dodávateľov do konca týždňa");
  await noteInput.press("Enter");
  await expect(page.locator(".uhrady-note-row")).toHaveCount(1);
  await page.getByTestId("uhrady-file-input").setInputFiles([pngFile("fa-m.png")]);
  await expect(page.locator(".uhrady-scan-card")).toHaveCount(1);

  // Sidebar štartuje na 390px v rail-móde — ručne rozbaliť (scenár #538).
  await page.getByTestId("sidebar-rail-toggle").click();
  await expect(page.locator(".sidebar.sidebar-rail")).toHaveCount(0);

  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

  // Upratať.
  await page.locator(".uhrady-scan-card").first().getByRole("button", { name: /^Odstrániť sken/ }).click();
  await page.locator(".uhrady-scan-card").first().getByRole("button", { name: "Áno, zmazať" }).click();
  await expect(page.getByTestId("uhrady-scans-empty")).toBeVisible();
  await page.locator(".uhrady-note-row").first().getByRole("button", { name: /^Odstrániť poznámku/ }).click();
  await expect(page.getByTestId("uhrady-notes-empty")).toBeVisible();

  expect(chyby).toEqual([]);
});
