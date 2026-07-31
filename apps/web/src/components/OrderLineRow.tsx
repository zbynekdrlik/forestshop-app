import { useEffect, useRef, useState, type JSX } from "react";
import type { OrderLine } from "../ordersApi.js";
import { formatVariantTotalChip, type VariantTotal } from "../ordersSummary.js";

// issue 60: `objednane` je VÝCHODISKOVÝ stav riadku (pred tým, než sa
// čokoľvek stane), NIE potvrdenie, že manažér objednal — preto sa nazýva
// "Nevybavené", nie "Objednané" (to slovo teraz patrí VÝLUČNE odškrtávaciemu
// políčku v tomto riadku, `OrderLine["ordered"]`, aby appka nemala na jednej
// obrazovke tri rôzne veci s tým istým názvom).
export const STATE_LABELS: Record<OrderLine["state"], string> = {
  objednane: "Nevybavené",
  caka_sa: "Čaká sa",
  skladom: "Skladom",
  nedostupne: "Nedostupné",
};

// Jeden riadok tabuľky "Na objednanie" — vyčlenené z `OrdersSection.tsx`
// (issue 60 pridalo odškrtávacie políčko + premenovaný stĺpec dátumu, čo
// poslalo pôvodný súbor cez eslint `max-lines: 400`, `.claude/rules/testing.md`).
export function OrderLineRow({
  line,
  canChangeState,
  busyLineId,
  busyOrderedLineId,
  supplierBusy,
  variantTotal,
  busySupplierLineId,
  onChangeState,
  onChangeOrdered,
  onAssignSupplier,
}: {
  readonly line: OrderLine;
  readonly canChangeState: boolean;
  readonly busyLineId: string | null;
  readonly busyOrderedLineId: string | null;
  // issue 62: súčet kusov tohto istého `variantCode` naprieč VŠETKÝMI
  // riadkami dodávateľa tohto riadku (`OrdersSection.tsx`'s
  // `computeVariantTotals(group.lines)`, nad NEFILTROVANOU skupinou) —
  // `undefined`, keď produkt v tejto skupine nemá k dispozícii súčet
  // (defenzívne, v praxi vždy nájdené, keďže mapa sa staví z tých istých
  // riadkov, z ktorých pochádza aj tento `line`).
  readonly variantTotal: VariantTotal | undefined;
  // Review of PR 75, finding 6: TRUE, keď práve prebieha hromadné "označiť/
  // zrušiť skupinu ako objednané" PRE DODÁVATEĽA tohto riadku
  // (`OrdersSection.tsx`'s `busyOrderedSupplier === group.supplier`) —
  // nezávislé od `busyOrderedLineId` (vlastný per-riadkový zápis). Bez toho
  // mohol manažér kliknúť na tento riadok ešte kým hromadný zápis pre celú
  // skupinu bežal, čo krátkodobo rozhádzalo optimistický UI (posledný zápis
  // vyhrá, žiadna strata dát, len zmätočné UX).
  readonly supplierBusy: boolean;
  // issue 63: riadok, ktorého ručné priradenie dodávateľa PRÁVE TERAZ ukladá
  // (needitovateľné, kým sa neskončí).
  readonly busySupplierLineId: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
  readonly onAssignSupplier: (lineId: string, supplier: string) => void;
}): JSX.Element {
  const qtyChip = variantTotal !== undefined ? formatVariantTotalChip(variantTotal) : null;

  // issue 63: lokálny koncept vstupu — controlled, ale RESETOVANÝ z props
  // vždy, keď server potvrdí novú hodnotu (`line.manualSupplierOverride`
  // sa zmení po úspešnom uložení + refetchi, `OrdersSection.tsx`'s
  // `assignSupplier`). Bez tohto by po uložení zostal v poli VIDIEŤ starý
  // koncept, keď riadok NEZMENÍ skupinu (rovnaký pravopis po normalizácii).
  const [supplierDraft, setSupplierDraft] = useState(line.manualSupplierOverride ?? "");
  // issue 89 (nezávislý audit, objavené novým testom `OrdersSection
  // .assignSupplier.test.tsx`): tento efekt PREDTÝM bežal aj pri PRVOM
  // mountnutí (React spúšťa `useEffect` vždy po prvom commite, bez ohľadu
  // na to, či sa "závislosť skutočne zmenila"), čo bolo úplne zbytočné
  // (`useState` vyššie už štartuje s TOU ISTOU hodnotou) — a navyše
  // pretekové: rýchla interakcia hneď po mounte (presne to, čo nový test
  // robí) mohla zachytiť tento oneskorený "reset na ''" AŽ PO tom, čo
  // manažér už stihol napísať koncept, a ticho ho vymazať (~1 z ~150
  // lokálnych behov). Skip na prvom mounte odstraňuje pretek — efekt teraz
  // reaguje len na SKUTOČNÚ zmenu `manualSupplierOverride` po uložení.
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    setSupplierDraft(line.manualSupplierOverride ?? "");
  }, [line.manualSupplierOverride]);
  const supplierBusyHere = busySupplierLineId === line.lineId;
  const saveSupplier = (): void => {
    const trimmed = supplierDraft.trim();
    if (trimmed === "") return;
    onAssignSupplier(line.lineId, trimmed);
  };

  return (
    <tr
      className={"order-row state-" + line.state + (line.ordered ? " ordered" : "")}
      data-testid={`order-line-${line.lineId}`}
    >
      <td>
        <input
          type="checkbox"
          data-testid={`ordered-checkbox-${line.lineId}`}
          aria-label={`Označiť riadok objednávky ${line.externalOrderId} / ${line.variantCode} ako objednané u dodávateľa`}
          checked={line.ordered}
          disabled={!canChangeState || busyOrderedLineId === line.lineId || supplierBusy}
          onChange={(e) => {
            onChangeOrdered(line.lineId, e.target.checked);
          }}
        />
      </td>
      <td>{line.externalOrderId}</td>
      <td>{line.customerName}</td>
      <td>{line.variantCode}</td>
      <td>{line.variantName}</td>
      <td>{line.sizeLabel ?? "—"}</td>
      <td className="ord-qty">
        {line.quantity} ks
        {qtyChip !== null && (
          <span className="qty-total-chip" data-testid={`qty-total-${line.lineId}`} title={qtyChip.title}>
            {qtyChip.text}
          </span>
        )}
      </td>
      <td className="ord-supplier-cell" data-testid={`supplier-link-${line.lineId}`}>
        {line.supplierUrl !== null ? (
          <a
            href={line.supplierUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ord-supplier-link"
            // issue 72: variantName sám nestačí — dva riadky toho istého
            // produktu v rôznych veľkostiach majú zhodný variantName, líšia
            // sa len variantCode.
            aria-label={`Odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`}
          >
            Odkaz na dodávateľa
          </a>
        ) : line.supplierNote !== null ? (
          <span className="ord-supplier-note" title={line.supplierNote}>
            {line.supplierNote}
          </span>
        ) : line.externalCode === null ? (
          "—"
        ) : null}
        {line.externalCode !== null && <div className="ord-supplier-code">kód {line.externalCode}</div>}
      </td>
      <td className="ord-supplier-assign" data-testid={`supplier-assign-cell-${line.lineId}`}>
        {line.supplierAssignable ? (
          <>
            <input
              type="text"
              // Jeden zdieľaný `<datalist id="known-suppliers">` (rendrovaný
              // raz v `OrdersSection.tsx`, z UŽ načítaných skupín) — žiadna
              // nová GET trasa netreba len na našepkávanie.
              list="known-suppliers"
              className="ord-supplier-assign-input"
              data-testid={`supplier-assign-input-${line.lineId}`}
              aria-label={`Priradiť dodávateľa riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
              placeholder="priradiť dodávateľa…"
              value={supplierDraft}
              disabled={supplierBusyHere}
              onChange={(e) => {
                setSupplierDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveSupplier();
                }
              }}
            />
            <button
              type="button"
              className="btn sm good"
              data-testid={`supplier-assign-save-${line.lineId}`}
              aria-label={`Uložiť priradenie dodávateľa riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
              disabled={supplierBusyHere || supplierDraft.trim() === ""}
              onClick={saveSupplier}
            >
              💾
            </button>
          </>
        ) : (
          "—"
        )}
      </td>
      <td>
        {canChangeState ? (
          <select
            // Code review finding (#25): pôvodne bez slova "stav" v
            // aria-labeli (obchádzka Playwright's substring
            // `getByLabel("Stav")` kolízie s katalógovým filtrom), čo by
            // čítačke obrazovky neoznámilo, čo tento prvok robí. Skutočná
            // oprava patrí na stranu KOLÍDUJÚCEHO testu (`catalog.spec.ts`
            // teraz používa `{ exact: true }`), nie na obetovanie
            // prístupnosti tu — tento select smie mať plnohodnotný popis.
            aria-label={`Zmeniť stav riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
            data-testid={`state-select-${line.lineId}`}
            className="ord-state-select"
            value={line.state}
            disabled={busyLineId === line.lineId}
            onChange={(e) => {
              onChangeState(line.lineId, e.target.value as OrderLine["state"]);
            }}
          >
            {(Object.keys(STATE_LABELS) as OrderLine["state"][]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        ) : (
          STATE_LABELS[line.state]
        )}
      </td>
      <td>{new Date(line.placedAt).toLocaleDateString("sk-SK")}</td>
      <td>{line.comment ?? "—"}</td>
    </tr>
  );
}
