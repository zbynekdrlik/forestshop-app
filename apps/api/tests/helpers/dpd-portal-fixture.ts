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
  /** issue 491: klik „Uložiť" v review kroku NIČ nespraví — review krok
   * NEZMIZNE ani sa NEZOBRAZÍ chyba (simuluje tichý/zaseknutý portál). Overuje
   * fail-loud „nepotvrdila" vetvu (`outcome !== "saved"`), aby appka nikdy
   * tiché ok:true pri nepotvrdenom odoslaní. */
  readonly pickupSaveHangs?: boolean;
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

function pickupFormPage(showInfoBanner: boolean, pickupSaveHangs: boolean): string {
  // issue 491 (reálny tvar, naživo domapované 26.8.2026): `/pickup-orders/0` je
  // JEDEN `<form class="data">` s `#pickup-date` (wj-input-date, vnútorný
  // `input[wj-part="input"]`) a `#button-confirmation` „Pokračovať". Klik
  // „Pokračovať" re-renderuje NA MIESTE na REVIEW krok — zmizne
  // `#button-confirmation`, objaví sa `#button-save` „Uložiť" (+ `.panel.warning`).
  // Skutočné odoslanie = klik `#button-save`. (Predtým fixtúra modelovala
  // hádané `#step1`/`#step2` step-container ID, ktoré v reálnom DOM NEEXISTUJÚ.)
  //
  // issue 451/491 info toasty (Štěpánov krok „zavrieť všetky hlášky"):
  // `shp-newsfeed-toast` v celoobrazovkovom `#toast-container` overlaye
  // (zachytáva pointer eventy nad formulárom), zatvárané tlačidlom „Zatvoriť"
  // (`.newsfeed-toast__button`). Druhé tlačidlo „Obsah správy" je DECOY — klik
  // naň overlay NEODstráni; implementácia, čo klikne na VŠETKY
  // `.newsfeed-toast__button` (alebo hádaný ✕/aria-label/close), by decoy
  // klikla / netrafila „Zatvoriť" → overlay zostane → klik na formulár zlyhá.
  const infoBanner = showInfoBanner
    ? `<div id="toast-container" class="toast-center-center toast-container" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,0.4)">
        <shp-newsfeed-toast class="toast-info toast newsfeed-toast">
          <div class="toast-title">Nové pravidlá v doručovaní do Holandska</div>
          <div class="newsfeed-toast__buttons">
            <button type="button" class="newsfeed-toast__button" data-role="close"><span class="newsfeed-toast__label">Zatvoriť</span></button>
            <button type="button" class="newsfeed-toast__button" data-role="content"><span class="newsfeed-toast__label">Obsah správy</span></button>
          </div>
        </shp-newsfeed-toast>
        <shp-newsfeed-toast class="toast-info toast newsfeed-toast">
          <div class="toast-title">Aktuálne obmedzenia a možné oneskorenia pri doručovaní zásielok</div>
          <div class="newsfeed-toast__buttons">
            <button type="button" class="newsfeed-toast__button" data-role="close"><span class="newsfeed-toast__label">Zatvoriť</span></button>
            <button type="button" class="newsfeed-toast__button" data-role="content"><span class="newsfeed-toast__label">Obsah správy</span></button>
          </div>
        </shp-newsfeed-toast>
      </div>
      <script>
        Array.prototype.forEach.call(document.querySelectorAll('shp-newsfeed-toast'), function (t) {
          t.querySelector('[data-role=close]').addEventListener('click', function () {
            t.remove();
            var c = document.getElementById('toast-container');
            if (c && c.querySelectorAll('shp-newsfeed-toast').length === 0) c.remove();
          });
          // "Obsah správy" (data-role=content) = DECOY: overlay zámerne NEODstráni
        });
      </script>`
    : "";
  return `<!doctype html><html><body>
    <div class="content-panel pickup-order-editor">
      <form id="pickup-step1" class="data ng-untouched ng-pristine ng-valid" novalidate="">
        <div class="panel"><h2>Podrobnosti</h2>
          <div class="ctl">
            <label for="pickup-date_input">Dátum vyzdvihnutia</label>
            <div id="pickup-date" class="wj-control wj-inputdate"><input wj-part="input" type="tel" class="wj-form-control" id="pickup-date_input" /></div>
          </div>
          <div class="ctl"><label for="note">Poznámka</label><textarea id="note"></textarea></div>
        </div>
        <div class="commands toolbar"><button type="button" id="button-confirmation">Pokračovať</button></div>
      </form>
      <div id="pickup-step2" class="data" style="display:none">
        <div class="panel wide warning">Prosím, skontrolujte údaje objednávky. Po jej uložení bude objednávka odoslaná do DPD.</div>
        <div class="commands toolbar">
          <button id="button-save"><span class="ic-floppydisk"></span><span class="label">Uložiť</span></button>
          <button id="button-back"><span class="ic-arrow-left-1"></span><span class="label">Späť</span></button>
        </div>
      </div>
    </div>
    ${infoBanner}
    <script>
      document.getElementById('button-confirmation').addEventListener('click', function () {
        window.__pickupDate = document.getElementById('pickup-date_input').value;
        document.getElementById('pickup-step1').style.display = 'none';
        document.getElementById('pickup-step2').style.display = 'block';
      });
      ${pickupSaveHangs
        ? "/* issue 491 pickupSaveHangs: žiadny listener na #button-save — klik je no-op (tichý portál). Review krok NEZMIZNE ani sa NEZOBRAZÍ chyba → appka musí fail-loud 'nepotvrdila'. */"
        : `document.getElementById('button-save').addEventListener('click', function () {
        fetch('/test/pickup-submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: window.__pickupDate }) })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            if (r.ok) {
              // úspech: review krok sa odpojí — appka deteguje detach #button-save
              var s = document.getElementById('pickup-step2'); if (s) s.remove();
            } else {
              document.body.insertAdjacentHTML('beforeend', '<div class="alert-danger">Zvoz sa nepodarilo objednať (test)</div>');
            }
          });
      });`}
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
    getCookie(c, COOKIE_NAME) === "ok"
      ? c.html(pickupFormPage(options.showInfoBanner ?? false, options.pickupSaveHangs ?? false))
      : c.html(loginPage()),
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
