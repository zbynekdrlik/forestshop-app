/**
 * issue 292: deterministický náhľad DPD zásielky priamo z uložených
 * objednávkových polí — ŽIADNE AI dohady (rovnaká disciplína ako
 * `.claude/rules/supplier-stock.md`/`restock-links.md`), obsluha si náhľad
 * môže pred odoslaním upraviť (hmotnosť), ale appka sama nič nehádaje.
 */

// Väčšina reálnych objednávok má `weight = 0` (obchod hmotnosť dôsledne
// nezapisuje, naživo overené na 90-dňovom exporte 7.8.2026) — appka preto
// dopĺňa tento rozumný predvolený odhad namiesto odoslania nezmyselnej
// nulovej hmotnosti portálu. Obsluha ho v náhľade môže pred odoslaním
// prepísať (`ShipmentConfirmInput.weightKgOverride`).
export const DEFAULT_PARCEL_WEIGHT_KG = "1.00";

// issue 292: formulár `/shipments/0` má rozmery balíka (šírka/výška/dĺžka,
// cm) ako POVINNÉ polia — zistené AŽ pri naživo domapovaní (9.8.2026),
// appka ich nikde neukladá (Shoptet export ich nemá) a nemá teda odkiaľ
// vziať skutočnú hodnotu. Rovnaký princíp ako hmotnosť vyššie — appka
// NIKDY nehádaje reálne rozmery konkrétneho balíka, len ponúka rozumný
// štartovací bod (malá/stredná krabica); obsluha ho pri potrebe upraví
// priamo v DPD portáli po uložení zásielky (appka tieto polia v UI
// needitovateľné, na rozdiel od hmotnosti — nie sú súčasťou náhľadu, ktorý
// obsluha bežne kontroluje pred odoslaním).
export const DEFAULT_PARCEL_WIDTH_CM = "30";
export const DEFAULT_PARCEL_HEIGHT_CM = "20";
export const DEFAULT_PARCEL_LENGTH_CM = "20";

// Naživo overené (7.8.2026, 90-dňový export): obe reálne používané spôsoby
// platby ("Dobierka (hotovosť) + karta (len SR)", "V hotovosti") obsahujú
// "hotovosť"/"dobierka" — appka rozpozná dobierku podľa toho, či názov
// platby obsahuje "dobierka" (bez ohľadu na veľkosť písmen). `paid`/
// `amountPaid` stĺpce sú v reálnom exporte takmer vždy nespoľahlivé/prázdne
// (`.claude/rules/dpd.md`), preto sa NEPOUŽÍVAJÚ ako zdroj tohto rozhodnutia.
const COD_PAYMENT_NAME_RE = /dobierka/i;

export interface DpdOrderSource {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly phone: string | null;
  readonly deliveryFullName: string | null;
  readonly deliveryCompany: string | null;
  readonly deliveryStreet: string | null;
  readonly deliveryHouseNumber: string | null;
  readonly deliveryCity: string | null;
  readonly deliveryZip: string | null;
  readonly deliveryCountryName: string | null;
  readonly weight: string | null;
  readonly paymentMethodName: string | null;
  readonly priceToPay: string | null;
  readonly totalPriceWithVat: string | null;
}

export interface DpdShipmentPreview {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly recipientName: string;
  readonly recipientCompany: string | null;
  readonly recipientPhone: string | null;
  readonly street: string | null;
  readonly houseNumber: string | null;
  readonly city: string | null;
  readonly zip: string | null;
  readonly countryName: string | null;
  // `false` = appka nemá dosť adresy na založenie zásielky (obsluha musí
  // adresu doplniť v Shoptete a počkať na ďalší import) — appka sama adresu
  // nikdy nedopĺňa/nehádaje.
  readonly addressComplete: boolean;
  readonly weightKg: string;
  readonly isCod: boolean;
  readonly codAmount: string | null;
}

function nonEmpty(value: string | null): boolean {
  return value !== null && value.trim() !== "";
}

/** `true`, keď je uložená hmotnosť chýbajúca ALEBO nulová — obe znamenajú
 * "appka reálnu hmotnosť nepozná", nie "balík naozaj váži 0". */
function isUsableWeight(raw: string | null): boolean {
  if (raw === null) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

export function buildDpdShipmentPreview(order: DpdOrderSource, weightKgOverride?: string): DpdShipmentPreview {
  const isCod = order.paymentMethodName !== null && COD_PAYMENT_NAME_RE.test(order.paymentMethodName);
  const codAmount = isCod ? (order.priceToPay ?? order.totalPriceWithVat) : null;
  const weightKg = weightKgOverride ?? (isUsableWeight(order.weight) ? (order.weight as string) : DEFAULT_PARCEL_WEIGHT_KG);
  // issue 292 review finding: súpisné/orientačné číslo je súčasťou adresy,
  // ktorú DPD potrebuje presne rovnako ako ulicu — objednávka bez neho nie
  // je "úplná adresa", aj keď ulica/mesto/PSČ/krajina sú vyplnené.
  const addressComplete =
    nonEmpty(order.deliveryStreet) &&
    nonEmpty(order.deliveryHouseNumber) &&
    nonEmpty(order.deliveryCity) &&
    nonEmpty(order.deliveryZip) &&
    nonEmpty(order.deliveryCountryName);

  return {
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    recipientName: order.deliveryFullName ?? order.customerName,
    recipientCompany: order.deliveryCompany,
    recipientPhone: order.phone,
    street: order.deliveryStreet,
    houseNumber: order.deliveryHouseNumber,
    city: order.deliveryCity,
    zip: order.deliveryZip,
    countryName: order.deliveryCountryName,
    addressComplete,
    weightKg,
    isCod,
    codAmount,
  };
}
