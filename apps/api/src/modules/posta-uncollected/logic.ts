import { globalContext, textValue } from "../mail-templates/context.js";
import type { MailTemplateKey } from "../mail-templates/registry.js";
import { renderTemplate, type MailTemplateText, type RenderedEmail } from "../mail-templates/render.js";
import { getZonedDateParts, zonedDateKey } from "../../timezone.js";
import {
  CANCELLED_STATUSES,
  daysNeededForNextEmail,
  DISPATCHED_STATUSES,
  MAX_EMAILS,
  MAX_PACKAGE_GAP_DAYS,
  MIN_DISPATCHED_FOR_ALARM,
  MIN_ELIGIBLE_FOR_BLIND_SPOT,
  MIN_PACKAGE_COVERAGE,
  NON_POSTA_CARRIER_KEYWORDS,
  RETURNED_STATE_CODES,
  TERMINAL_STATE_CODES,
  trackingLink,
} from "./constants.js";

// Čistá logika (žiadna DB, žiadna sieť) — verný port `posta_uncollected.py`,
// prispôsobený TAK, aby čítal priamo z `order` riadkov (nie z CSV), viď
// návrhový komentár na issue 172.

export interface EligibleOrder {
  readonly externalOrderId: string;
  readonly placedAt: Date;
  readonly statusName: string;
  readonly shippingCarrierName: string | null;
  readonly packageNumber: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly customerName: string;
  // issue 120: keď je známe, `queries.ts`'s `buildShoptetAdminOrderUrl` dá
  // priamy odkaz na detail objednávky namiesto vyhľadávania.
  readonly shoptetOrderId: number | null;
}

export function isNonPostaCarrier(name: string | null): boolean {
  const n = (name ?? "").toLowerCase();
  return NON_POSTA_CARRIER_KEYWORDS.some((k) => n.includes(k));
}

/** Objednávka, za ktorú je táto automatizácia zodpovedná — BEZ filtra na
 * vyplnené číslo zásielky (rovnaký zámer ako stará appka's `_eligible_orders`,
 * zdieľané aj s `sourceCoverage` nižšie, aby poistka nikdy nepočítala INÚ
 * množinu objednávok než tá, ktorú automatizácia reálne naháňa). */
export function isEligibleOrder(
  order: EligibleOrder,
  today: Date,
  cancelledStatuses: ReadonlySet<string> = CANCELLED_STATUSES,
): boolean {
  if (cancelledStatuses.has(order.statusName)) return false;
  if (isNonPostaCarrier(order.shippingCarrierName)) return false;
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  return order.placedAt >= cutoff;
}

export interface SourceCoverage {
  readonly eligibleOrders: number;
  readonly dispatchedOrders: number;
  readonly dispatchedWithPackage: number;
  readonly dispatchedWithoutPackage: number;
  readonly missingPackage: number;
  readonly daysSinceLastPackage: number | null;
  readonly dispatchedStatusUnknown: boolean;
  readonly degraded: boolean;
}

/** Coverage/blind-spot poistka (#282/#298 starej appky) — pozri
 * `constants.ts` pre plné odôvodnenie prahov. */
export function sourceCoverage(
  eligible: readonly EligibleOrder[],
  today: Date,
  dispatchedStatuses: ReadonlySet<string> = DISPATCHED_STATUSES,
): SourceCoverage {
  const dispatched = eligible.filter((o) => dispatchedStatuses.has(o.statusName));
  const withPkg = dispatched.filter((o) => (o.packageNumber ?? "") !== "");
  const pkgDates = eligible
    .filter((o) => (o.packageNumber ?? "") !== "" && o.placedAt <= today)
    .map((o) => o.placedAt);
  const lastPkg = pkgDates.length > 0 ? new Date(Math.max(...pkgDates.map((d) => d.getTime()))) : null;
  const dispDates = dispatched.filter((o) => o.placedAt <= today).map((o) => o.placedAt);
  const lastDispatch = dispDates.length > 0 ? new Date(Math.max(...dispDates.map((d) => d.getTime()))) : null;

  const dispatchedStatusUnknown =
    dispatched.length < MIN_DISPATCHED_FOR_ALARM &&
    (eligible.length >= MIN_ELIGIBLE_FOR_BLIND_SPOT ||
      (dispatched.length === 0 && eligible.length >= MIN_DISPATCHED_FOR_ALARM));

  let degraded = false;
  if (dispatched.length >= MIN_DISPATCHED_FOR_ALARM) {
    const thin = withPkg.length / dispatched.length < MIN_PACKAGE_COVERAGE;
    const stale =
      lastPkg !== null &&
      lastDispatch !== null &&
      Math.floor((lastDispatch.getTime() - lastPkg.getTime()) / 86_400_000) >= MAX_PACKAGE_GAP_DAYS;
    degraded = thin || stale;
  }

  return {
    eligibleOrders: eligible.length,
    dispatchedOrders: dispatched.length,
    dispatchedWithPackage: withPkg.length,
    dispatchedWithoutPackage: dispatched.length - withPkg.length,
    missingPackage: eligible.filter((o) => (o.packageNumber ?? "") === "").length,
    daysSinceLastPackage: lastPkg === null ? null : Math.floor((today.getTime() - lastPkg.getTime()) / 86_400_000),
    dispatchedStatusUnknown,
    degraded,
  };
}

export interface TrackingClassification {
  readonly status: string;
  readonly uncollected: boolean;
  readonly officeName: string;
  readonly officeAddr: string;
  readonly retainedTill: string;
  readonly notifiedSince: string;
  readonly daysAtPost: number;
}

// `String(unknown ?? "")` je zakázané (`no-base-to-string` — nevie dokázať,
// že `unknown` hodnota nie je objekt, ktorý by sa vypísal ako
// "[object Object]"). API odpoveď je nedôveryhodná (tretia strana), preto
// KAŽDÉ pole z nej ide cez toto: `string` sa vezme, čokoľvek iné (číslo,
// objekt, `undefined`) sa stane prázdnym reťazcom.
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseIsoDatePrefix(value: unknown): Date | null {
  const s = asString(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface TrackingEvent {
  readonly stateCode?: unknown;
  readonly detailCode?: unknown;
  readonly localDate?: unknown;
  readonly retainedTill?: unknown;
  readonly postOffice?: { readonly name?: unknown; readonly street?: unknown; readonly postcode?: unknown; readonly city?: unknown };
}

interface TrackingResult {
  readonly status?: unknown;
  readonly events?: readonly TrackingEvent[];
  readonly retainedTill?: unknown;
}

interface TrackingApiResponse {
  readonly results?: readonly TrackingResult[];
}

/** Pošta SK tracking odpoveď → klasifikácia — port `classify_tracking`
 * (Code node starej appky). `status`: 'ok' | 'invalid_format' | 'no_results'
 * | 'no_events' | čokoľvek API vráti. */
export function classifyTracking(apiJson: unknown, today: Date): TrackingClassification {
  const out: {
    status: string;
    uncollected: boolean;
    officeName: string;
    officeAddr: string;
    retainedTill: string;
    notifiedSince: string;
    daysAtPost: number;
  } = {
    status: "no_results",
    uncollected: false,
    officeName: "",
    officeAddr: "",
    retainedTill: "",
    notifiedSince: "",
    daysAtPost: 1,
  };
  const results = (apiJson as TrackingApiResponse | null)?.results ?? [];
  const p = results[0];
  if (p === undefined) return out;
  out.status = typeof p.status === "string" && p.status !== "" ? p.status : "no_results";
  if (out.status !== "ok") return out; // invalid_format a pod. — žiadne udalosti
  const events = p.events ?? [];
  const last = events[events.length - 1];
  if (last === undefined) {
    out.status = "no_events";
    return out;
  }
  const state = asString(last.stateCode).toLowerCase();
  const detail = asString(last.detailCode).toUpperCase();
  if (state === "notified" && detail.startsWith("ZNP")) {
    out.uncollected = true;
    const po = last.postOffice ?? {};
    out.officeName = asString(po.name);
    const street = asString(po.street);
    if (street !== "") {
      out.officeAddr = `${street}, ${asString(po.postcode)} ${asString(po.city)}`.trim();
    }
    const ld = asString(last.localDate).slice(0, 10);
    out.notifiedSince = ld;
    const nd = parseIsoDatePrefix(ld);
    if (nd !== null) {
      out.daysAtPost = Math.max(1, Math.floor((today.getTime() - nd.getTime()) / 86_400_000));
    }
    // Termín vyzdvihnutia — živé api.posta.sk ho vracia na RESULT úrovni
    // (stará appka #283), event je len záložný tvar.
    const rawTill = p.retainedTill ?? events.find((e) => e.retainedTill !== undefined)?.retainedTill;
    if (rawTill !== undefined && rawTill !== null && rawTill !== "") {
      const d = parseIsoDatePrefix(rawTill);
      // issue 293: `zonedDateKey` namiesto `toISOString().slice(0, 10)` —
      // konzistentné s `state.ts`/`run.ts`. `d` je tu vždy UTC polnoc
      // (`parseIsoDatePrefix` posta.sk-ovho ČISTO kalendárneho dátumu bez
      // časovej zložky), takže prevod na Europe/Bratislava NIKDY neposunie
      // deň (miestna polnoc + 1-2h offset ostáva v TEN istý kalendárny
      // deň) — ide o zjednotenie ciest, nie o opravu pozorovateľného chýbania.
      out.retainedTill = d !== null ? zonedDateKey(d) : "";
    }
  }
  return out;
}

export function terminalState(apiJson: unknown): string {
  const results = (apiJson as TrackingApiResponse | null)?.results ?? [];
  const p = results[0];
  if (p === undefined || (typeof p.status === "string" ? p.status : "") !== "ok") return "";
  const events = p.events ?? [];
  const last = events[events.length - 1];
  if (last === undefined) return "";
  const state = asString(last.stateCode).trim().toLowerCase();
  return TERMINAL_STATE_CODES.has(state) ? state : "";
}

// issue 299: zásielka VRÁTENÁ ODOSIELATEĽOVI — NEPOTVRDENÁ klasifikácia
// (plné odôvodnenie a bezpečnostné dôsledky v `constants.ts`'s
// `RETURNED_STATE_CODES` komentári). Zámerne SAMOSTATNÁ od `terminalState`
// (nezdieľa `TERMINAL_STATE_CODES`, nikdy sa necachuje ako trvalá) — volajúci
// (`run.ts`) preto túto funkciu overuje ZNOVA pri každom behu.
export function isReturnedToSender(apiJson: unknown): boolean {
  const results = (apiJson as TrackingApiResponse | null)?.results ?? [];
  const p = results[0];
  if (p === undefined || (typeof p.status === "string" ? p.status : "") !== "ok") return false;
  const events = p.events ?? [];
  const last = events[events.length - 1];
  if (last === undefined) return false;
  const state = asString(last.stateCode).trim().toLowerCase();
  return RETURNED_STATE_CODES.has(state);
}

// issue 268: stabilný dedup kľúč pre nástenku Upozornenia (`upozornenia
// /service.ts`'s `upsertUpozornenie`/`autoResolveByDedupKey`) — číslo
// zásielky sa v rámci jednej zásielky nemení, takže opakovaný denný beh
// vždy trafí TEN istý riadok. Presne tvar, aký schéma (`schema-upozornenia
// .ts`) aj existujúce testy (`upozornenia-service.integration.test.ts`)
// dokumentujú ako príklad ("posta:EF123456789SK").
export function postaUpozornenieDedupKey(packageNumber: string): string {
  return `posta:${packageNumber}`;
}

// issue 299: DRUHÝ, SAMOSTATNÝ menný priestor pre "vrátená odosielateľovi" —
// zámerne INÝ prefix než `postaUpozornenieDedupKey` vyššie, aby jedna
// zásielka nikdy nekolidovala sama so sebou naprieč dvoma rôznymi
// významami (`.claude/rules/upozornenia.md`).
export function postaReturnedUpozornenieDedupKey(packageNumber: string): string {
  return `posta-vratena:${packageNumber}`;
}

export function shouldSend(count: number, lastSent: Date | null, today: Date): boolean {
  if (count >= MAX_EMAILS) return false;
  if (count === 0) return true;
  if (lastSent === null) return false;
  const needed = daysNeededForNextEmail(count);
  const days = Math.floor((today.getTime() - lastSent.getTime()) / 86_400_000);
  return days >= needed;
}

export type BuiltEmail = RenderedEmail;

/** Ktorá zo štyroch zásielkových šablón patrí k tomuto poradiu e-mailu —
 * eskalácia sa zachováva presne ako predtým (1./2./3. a posledná výzva pre
 * štvrtý a každý ďalší). */
export function postaTemplateKey(count: number): MailTemplateKey {
  if (count <= 1) return "posta_1";
  if (count === 2) return "posta_2";
  if (count === 3) return "posta_3";
  return "posta_4";
}

/** Dosadí hodnoty do šablóny vybranej `postaTemplateKey`. Dátum, ktorý už
 * PREŠIEL (alebo sa nedá prečítať), sa berie ako žiadny — šablóna má na ten
 * prípad vlastnú vetvu `{{#ak termin_vyzdvihnutia}}…{{inak}}…{{/ak}}`,
 * rovnaký zámer ako pôvodná dvojica viet v starej appke's `build_email`. */
export function buildEmail(
  template: MailTemplateText,
  name: string,
  trackNum: string,
  officeName: string,
  officeAddr: string,
  retainedTill: string,
  today: Date,
): BuiltEmail {
  const d = retainedTill !== "" ? parseIsoDatePrefix(retainedTill) : null;
  // issue 293 review finding: `d` je VŽDY UTC-polnočný kalendárny dátum
  // (`parseIsoDatePrefix` vyššie), takže "UTC" pásmo tu dá identický
  // výsledok ako predošlé vlastné `getUTC*` volania — jediný rozdiel je, že
  // teraz ide cez ROVNAKÝ zdieľaný helper ako zvyšok modulu (`zonedDateKey`
  // nižšie), namiesto vlastnej duplicitnej Y/M/D extrakcie.
  const retainedTillDisplay =
    d !== null && d >= today
      ? (() => {
          const parts = getZonedDateParts(d, "UTC");
          return `${String(parts.day)}. ${String(parts.month)}. ${String(parts.year)}`;
        })()
      : "";
  const link = trackingLink(trackNum);
  return renderTemplate(template, {
    ...globalContext(),
    meno_zakaznika: textValue(name),
    cislo_zasielky: textValue(trackNum),
    posta: textValue(officeName),
    adresa_posty: textValue(officeAddr),
    termin_vyzdvihnutia: textValue(retainedTillDisplay),
    odkaz_sledovanie: { kind: "link", url: link, label: link },
  });
}
