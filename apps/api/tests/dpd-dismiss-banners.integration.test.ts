// issue 603 (review): DPD portál kreslí info hlášky asynchrónne (Angular newsfeed).
// `dismissInfoBanners` musí počkať aj na hlášku, ktorá sa objaví chvíľu po načítaní,
// inak ju nechá otvorenú a tá zachytí klik na formulár.

import { chromium, type Browser } from "playwright";
import { afterEach, expect, it } from "vitest";
import { dismissInfoBanners } from "../src/modules/dpd/portal-fill.js";
import { resolveChromiumExecutablePath } from "../src/modules/shoptet-writeback/playwright-import.js";

const TOAST = `<shp-newsfeed-toast><div class="toast-title">Neskorá hláška</div>
  <button type="button"><span class="ic-close-circle"></span><span>close</span></button></shp-newsfeed-toast>`;

let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

it("zavrie hlášku, ktorá sa objaví až 600 ms po zavolaní", async () => {
  const executablePath = resolveChromiumExecutablePath();
  browser = await chromium.launch({ ...(executablePath === undefined ? {} : { executablePath }), args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><script>
    setTimeout(function () {
      var holder = document.createElement('div');
      holder.innerHTML = ${JSON.stringify(TOAST)};
      document.body.appendChild(holder);
      holder.querySelector('button').addEventListener('click', function () { holder.remove(); });
    }, 600);
  </script></body></html>`);

  await dismissInfoBanners(page);
  await page.waitForTimeout(1000);

  expect(await page.locator("shp-newsfeed-toast").count()).toBe(0);
}, 60_000);
