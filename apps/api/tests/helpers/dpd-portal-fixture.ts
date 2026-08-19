import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AddressInfo } from "node:net";

/**
 * issue 292: falošný `dpdshipper.sk` — imituje LEN tvar, ktorý
 * `shipment-playwright.ts`/`pickup-playwright.ts` naozaj ovládajú (rovnaká
 * disciplína ako `shoptet-fixture.ts`, `.claude/rules/shoptet-writeback.md`).
 * Skutočný portál je Angular/wijmo aplikácia — táto fixtúra ju nereplikuje
 * bajt-po-bajte (to overuje LEN živé prihlásenie, `.claude/rules/dpd.md`),
 * len ID/atribúty/vnorenie prvkov, ktoré naša automatizácia SKUTOČNE
 * ovláda (selektory naživo domapované 9.8.2026), plus dve konfigurovateľné
 * čakacie/chybové správania (produkt/COD trvalo disabled, chyba pri
 * objednaní zvozu) na overenie fail-loud ciest.
 */

const COOKIE_NAME = "dpd-sid";

export interface DpdFixtureOptions {
  readonly user: string;
  readonly password: string;
  /** Produkt/COD prepínače NIKDY nepovolí (simuluje portál, čo sa nikdy
   * nedokončí inicializovať) — na overenie fail-loud timeoutu. */
  readonly stuckDisabled?: boolean;
  /** Krok 2 objednávky zvozu po Uložení ukáže chybu namiesto úspechu. */
  readonly pickupSaveFails?: boolean;
  /** issue 451 (Štěpánov krok 2): formulár zvozu prekryje celoobrazovkový
   * info banner („Aktuálne obmedzenia…") so zatváracím ✕ — kým sa nezavrie,
   * zachytáva kliky na polia/tlačidlá formulára (na overenie, že robot
   * banner najprv zatvorí, inak by `Pokračovať`/`Uložiť` klik zlyhal). */
  readonly showInfoBanner?: boolean;
  /** Po uložení zásielky NEUKÁŽE toast — núti appku ísť záložnou cestou
   * (zoznam Zásielky filtrovaný podľa referencie), na overenie, že táto
   * cesta naozaj nájde SKUTOČNÉ číslo zásielky, nie appka's vlastnú
   * referenciu, ktorá je v tom istom riadku (code review, issue 292,
   * PR 324). */
  readonly shipmentSkipToast?: boolean;
}

export interface DpdShipmentSubmission {
  readonly reference: string;
  readonly name: string;
  readonly street: string;
  readonly houseNr: string;
  readonly zip: string;
  readonly city: string;
  readonly phone: string;
  readonly weight: string;
  readonly width: string;
  readonly height: string;
  readonly length: string;
  readonly codChecked: boolean;
  readonly codAmount: string | null;
}

export interface DpdFixture {
  readonly baseUrl: string;
  readonly lastShipmentSubmission: () => DpdShipmentSubmission | null;
  readonly lastPickupDate: () => string | null;
  close(): Promise<void>;
}

function loginPage(): string {
  return `<!doctype html><html><body>
    <form method="post" action="/login">
      <input id="loginName" name="loginName" type="text" />
      <input name="password" type="password" />
      <button type="submit">Prihlásiť</button>
    </form>
  </body></html>`;
}

function shipmentFormPage(stuckDisabled: boolean, skipToast: boolean): string {
  const disabledAttr = "disabled";
  const enableScript = stuckDisabled
    ? ""
    : `<script>setTimeout(function(){
        document.getElementById('product_Home').removeAttribute('disabled');
        document.getElementById('service-COD').removeAttribute('disabled');
      }, 200);</script>`;
  // `.then()` po uložení: buď ukáž toast (bežná cesta), alebo NIČ (núti
  // appku ísť záložnou cestou cez zoznam Zásielky — `skipToast`, code
  // review issue 292 PR 324).
  const afterSaveScript = skipToast
    ? ""
    : `document.body.insertAdjacentHTML('beforeend', '<div id="toast-container"><div>Zásielka uložená, číslo 99900000123</div></div>');`;
  return `<!doctype html><html><body>
    <input type="radio" id="product_Home" ${disabledAttr} />
    <input type="text" id="referential-info1" />
    <shp-universal-number-input name="parcelWeight"><input placeholder="Hmotnosť" /></shp-universal-number-input>
    <input name="parcelWidth" />
    <input name="parcelHeight" />
    <input name="parcelLength" />
    <ng2-completer id="shipment_order_recipient-recipient-name"><div class="completer-holder"><input type="search" /></div></ng2-completer>
    <input type="text" id="shipment_order_recipient-recipient-name2" />
    <input type="text" id="shipment_order_recipient-recipient-street" />
    <input type="text" id="shipment_order_recipient-recipient-house-nr" />
    <ng2-completer id="shipment_order_recipient-recipient-zip"><div class="completer-holder"><input type="search" /></div></ng2-completer>
    <ng2-completer id="shipment_order_recipient-recipient-city"><div class="completer-holder"><input type="search" /></div></ng2-completer>
    <input type="text" name="number" />
    <div class="additional-service">
      <input type="hidden" id="cod-decoy" value="uz-existujuci-vstup-nie-suma" />
      <input type="checkbox" id="service-COD" ${disabledAttr} />
      <label for="service-COD">Dobierka</label>
    </div>
    ${enableScript}
    <button type="button" id="save-btn">Uložiť &amp; Nová</button>
    <script>
      document.getElementById('service-COD').addEventListener('change', function (e) {
        var container = e.target.closest('.additional-service');
        if (e.target.checked && !container.querySelector('input[name=codAmount]')) {
          var amountInput = document.createElement('input');
          amountInput.setAttribute('name', 'codAmount');
          container.appendChild(amountInput);
        }
      });
      document.getElementById('save-btn').addEventListener('click', function () {
        var byId = function (id) { return document.getElementById(id); };
        var val = function (sel) { var el = document.querySelector(sel); return el ? el.value : ""; };
        var codChecked = byId('service-COD').checked;
        var payload = {
          reference: byId('referential-info1').value,
          name: val('#shipment_order_recipient-recipient-name input[type=search]'),
          street: byId('shipment_order_recipient-recipient-street').value,
          houseNr: byId('shipment_order_recipient-recipient-house-nr').value,
          zip: val('#shipment_order_recipient-recipient-zip input[type=search]'),
          city: val('#shipment_order_recipient-recipient-city input[type=search]'),
          phone: val('input[name=number]'),
          weight: val('input[placeholder="Hmotnosť"]'),
          width: val('input[name=parcelWidth]'),
          height: val('input[name=parcelHeight]'),
          length: val('input[name=parcelLength]'),
          codChecked: codChecked,
          codAmount: codChecked ? val('input[name=codAmount]') : null,
        };
        fetch('/test/shipment-submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
          .then(function () {
            ${afterSaveScript}
          });
      });
    </script>
  </body></html>`;
}

// Naschvál v poradí referencia PRED skutočným číslom zásielky v tom istom
// riadku — presne tam, kde sa dala predošlá (opravená) chyba prejaviť:
// appka hľadá riadok PODĽA referencie, takže referencia je v ňom vždy
// prítomná, a naivný regex by ju mohol vrátiť namiesto 14-miestneho čísla
// zásielky (code review, issue 292, PR 324).
export const FAKE_LIST_PARCEL_NUMBER = "12345678901234";

function shipmentsListPage(reference: string | null): string {
  const row = reference !== null ? `<tr><td>${reference}</td><td>Ján Testovací</td><td>${FAKE_LIST_PARCEL_NUMBER}</td></tr>` : "";
  return `<!doctype html><html><body><table>${row}</table></body></html>`;
}

function pickupFormPage(showInfoBanner: boolean): string {
  // issue 451: celoobrazovkový prekrývací info banner s ✕ — vysoký z-index
  // (zachytáva pointer eventy nad formulárom), zatvárateľný `aria-label
  // "Zavrieť"`/text ✕. Kým sa nezavrie, `Pokračovať`/`Uložiť` klik zachytí
  // tento banner a zlyhá — presne ten stav, ktorý `dismissInfoBanners`
  // (Štěpánov krok 2) rieši.
  const infoBanner = showInfoBanner
    ? `<div id="dpd-info-banner" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,0.4)">
        <div class="alert-info" style="padding:1rem">Aktuálne obmedzenia v doručovaní.
          <button type="button" id="info-banner-close" class="banner-close" aria-label="Zavrieť">✕</button>
        </div>
      </div>
      <script>
        document.getElementById('info-banner-close').addEventListener('click', function () {
          var b = document.getElementById('dpd-info-banner'); if (b) b.remove();
        });
      </script>`
    : "";
  return `<!doctype html><html><body>
    ${infoBanner}
    <div id="pickup-date"><input wj-part="input" id="pickup-date-input" /></div>
    <div id="step1"><button type="button" id="button-confirmation">Pokračovať</button></div>
    <div id="step2" style="display:none"><button type="button" id="save-btn2">Uložiť</button></div>
    <script>
      document.getElementById('button-confirmation').addEventListener('click', function () {
        document.getElementById('step1').style.display = 'none';
        document.getElementById('step2').style.display = 'block';
      });
      document.getElementById('save-btn2').addEventListener('click', function () {
        var date = document.getElementById('pickup-date-input').value;
        fetch('/test/pickup-submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: date }) })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            if (!r.ok) {
              document.body.insertAdjacentHTML('beforeend', '<div class="alert-danger">Zvoz sa nepodarilo objednať (test)</div>');
            }
          });
      });
    </script>
  </body></html>`;
}

export async function startDpdFixture(options: DpdFixtureOptions): Promise<DpdFixture> {
  const app = new Hono();
  let lastShipment: DpdShipmentSubmission | null = null;
  let lastPickupDate: string | null = null;

  app.get("/login", (c) => c.html(loginPage()));

  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    if (body["loginName"] === options.user && body["password"] === options.password) {
      setCookie(c, COOKIE_NAME, "ok", { httpOnly: true, path: "/" });
      return c.redirect("/shipments", 303);
    }
    return c.redirect("/login", 303);
  });

  app.get("/shipments", (c) =>
    getCookie(c, COOKIE_NAME) === "ok" ? c.html(shipmentsListPage(lastShipment?.reference ?? null)) : c.html(loginPage()),
  );

  app.get("/shipments/0", (c) =>
    getCookie(c, COOKIE_NAME) === "ok" ? c.html(shipmentFormPage(options.stuckDisabled ?? false, options.shipmentSkipToast ?? false)) : c.html(loginPage()),
  );

  app.post("/test/shipment-submit", async (c) => {
    lastShipment = await c.req.json<DpdShipmentSubmission>();
    return c.json({ ok: true });
  });

  app.get("/pickup-orders/0", (c) =>
    getCookie(c, COOKIE_NAME) === "ok" ? c.html(pickupFormPage(options.showInfoBanner ?? false)) : c.html(loginPage()),
  );

  app.post("/test/pickup-submit", async (c) => {
    const body = await c.req.json<{ readonly date: string }>();
    lastPickupDate = body.date;
    return c.json({ ok: options.pickupSaveFails !== true });
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => {
      resolve(s as unknown as import("node:http").Server);
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    lastShipmentSubmission: () => lastShipment,
    lastPickupDate: () => lastPickupDate,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
