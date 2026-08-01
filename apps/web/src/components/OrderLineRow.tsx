import { useEffect, useRef, useState, type JSX } from "react";
import type { OrderLine } from "../ordersApi.js";
import { formatVariantTotalChip, isStaleOrderLine, orderLineAgeDays, type VariantTotal } from "../ordersSummary.js";

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
  busySupplierLinkLineId,
  busyCommentOrderId,
  onChangeState,
  onChangeOrdered,
  onAssignSupplier,
  onSetSupplierLink,
  onChangeComment,
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
  // issue 121: riadok, ktorého odkaz na dodávateľa PRÁVE TERAZ ukladá —
  // nezávislé od `busySupplierLineId` vyššie (iný zápis, iná trasa).
  readonly busySupplierLinkLineId: string | null;
  // issue 64: objednávka (nie riadok — poznámka patrí CELEJ objednávke),
  // ktorej poznámka PRÁVE TERAZ ukladá.
  readonly busyCommentOrderId: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
  readonly onAssignSupplier: (lineId: string, supplier: string) => void;
  // issue 121: manuálny odkaz na dodávateľa — smie sa upraviť pri KAŽDOM
  // riadku (na rozdiel od `onAssignSupplier`, ktorý je len pre riadky bez
  // katalógového dodávateľa).
  readonly onSetSupplierLink: (lineId: string, url: string) => void;
  readonly onChangeComment: (orderId: string, comment: string | null) => void;
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

  // issue 121: TOGGLE (nie trvalo viditeľný vstup ako `supplierDraft`
  // vyššie) — draft sa prednaplní ČERSTVOU `line.supplierUrl` hodnotou pri
  // KAŽDOM otvorení (nie udržiavaný cez `useEffect`), takže nehrozí rovnaký
  // "reset pri prvom mounte"/pretek, aký `supplierDraft`/`commentDraft` museli
  // riešiť guardom (`.claude/rules/frontend-design.md`). Zavretie panelu je
  // OPTIMISTICKÉ (hneď pri kliku na Uložiť) — jednoduchšie než čakať na
  // potvrdenie servera, a pri zlyhaní ostáva chyba viditeľná v `stateError`
  // banneri, manažér otvorí úpravu znova.
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const linkBusyHere = busySupplierLinkLineId === line.lineId;
  const toggleLinkEditing = (): void => {
    if (linkEditing) {
      setLinkEditing(false);
      return;
    }
    setLinkDraft(line.supplierUrl ?? "");
    setLinkEditing(true);
  };
  const saveLink = (): void => {
    const trimmed = linkDraft.trim();
    if (trimmed === "") return;
    onSetSupplierLink(line.lineId, trimmed);
    setLinkEditing(false);
  };

  // issue 64: rovnaký "controlled draft, resetovaný z props po uložení"
  // vzor ako `supplierDraft` vyššie — vrátane rovnakého "skip prvý mount"
  // guardu (`.claude/rules/frontend-design.md`'s zdokumentovaný pretek: bez
  // neho by rýchla interakcia hneď po mounte mohla zachytiť oneskorený
  // reset a ticho prepísať rozostavaný koncept). NEZÁVISLÝ od `line.comment`
  // zmeny cez INÝ riadok tej istej objednávky — každý riadok má vlastnú
  // kópiu draftu, ale všetky sa po uložení prepíšu na TÚ ISTÚ hodnotu
  // (`OrdersSection.tsx`'s `changeComment` aktualizuje všetky riadky s
  // rovnakým `orderId`), takže syncujú aj bez zdieľaného stavu.
  //
  // Code review (issue 64, pred mergom): keďže poznámka je zdieľaná naprieč
  // VŠETKÝMI riadkami tej istej objednávky, uloženie poznámky cez INÝ riadok
  // (napr. riadok B) tej istej objednávky zmení `line.comment` aj na TOMTO
  // riadku (A) — bez ďalšieho stráženia by vyššie uvedený reset efekt vtedy
  // zbehol AJ na riadku A a ticho by prepísal jeho ešte NEULOŽENÝ rozpísaný
  // koncept. `isCommentDirty` sleduje presne toto: nastaví sa pri KAŽDOM
  // stlačení klávesy vo vstupe, vyčistí sa až pri KLIKU na uložiť TOHTO
  // riadku (optimisticky — zápis môže ešte bežať, ale vstup je vtedy aj tak
  // `disabled`, viď `commentBusyHere` nižšie, takže sa medzitým nedá znova
  // rozpísať). Reset efekt teda prepíše draft LEN keď manažér na TOMTO
  // riadku práve NIČ nerozpisuje.
  const [commentDraft, setCommentDraft] = useState(line.comment ?? "");
  const isCommentFirstMount = useRef(true);
  const isCommentDirty = useRef(false);
  useEffect(() => {
    if (isCommentFirstMount.current) {
      isCommentFirstMount.current = false;
      return;
    }
    if (isCommentDirty.current) return;
    setCommentDraft(line.comment ?? "");
  }, [line.comment]);
  const commentBusyHere = busyCommentOrderId === line.orderId;
  const saveComment = (): void => {
    const trimmed = commentDraft.trim();
    isCommentDirty.current = false;
    onChangeComment(line.orderId, trimmed === "" ? null : trimmed);
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
      <td className="ord-order-cell">
        {/* issue 65: priamy odkaz do Shoptet administrácie na TÚTO
            objednávku (`queries.ts`'s `buildShoptetAdminOrderUrl`).
            issue 99: klikateľné je samotné ČÍSLO objednávky (majiteľ žiadal
            doslovne "keď kliknem na kód objednávky") — pôvodná samostatná
            ikonka `🔗` vedľa čísla zanikla, `line.adminUrl` sa nemení. */}
        <a
          href={line.adminUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="ord-admin-link"
          aria-label={`Otvoriť objednávku ${line.externalOrderId} v administrácii Shoptet`}
          title="Otvoriť v administrácii Shoptet"
        >
          {line.externalOrderId}
        </a>
      </td>
      <td>{line.customerName}</td>
      <td>{line.variantName}</td>
      <td className="ord-qty">
        {line.quantity} ks
        {qtyChip !== null && (
          <span className="qty-total-chip" data-testid={`qty-total-${line.lineId}`} title={qtyChip.title}>
            {qtyChip.text}
          </span>
        )}
      </td>
      {/* issue 95: DODÁVATEĽ + PRIRADENIE DODÁVATEĽA zlúčené do jednej bunky
          (majiteľ, komentár #1) — oba vnorené bloky nižšie sú BEZ ZMENY
          (rovnaké testid, rovnaká logika), len vedľa seba v jednej `<td>`
          namiesto dvoch samostatných stĺpcov. */}
      <td className="ord-supplier-merged">
        <div className="ord-supplier-row">
          <div className="ord-supplier-cell" data-testid={`supplier-link-${line.lineId}`}>
            {line.supplierUrl !== null ? (
              // issue 119: majiteľ, doslovne "zmen na nejake tlacitko z ikonou
              // ktore otvori na novom okne ten link, lebo teraz to je tazke
              // stlacit" — textový odkaz nahradený veľkým ikonovým tlačidlom
              // (`.ord-supplier-link` v `app.css` teraz štylizuje `<a>` ako
              // tlačidlo, min. 36×36px klikacej plochy). `aria-label`/`title`
              // nesú ten istý popis ako predtým (issue 72: variantName sám
              // nestačí — dva riadky toho istého produktu v rôznych veľkostiach
              // majú zhodný variantName, líšia sa len variantCode), viditeľný
              // text je teraz len ikonka (`aria-hidden`, prístupné meno nesie
              // výlučne `aria-label`).
              <a
                href={line.supplierUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="ord-supplier-link"
                aria-label={`Odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`}
                title={`Otvoriť odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`}
              >
                <span aria-hidden="true">🔗</span>
              </a>
            ) : line.supplierNote !== null ? (
              <span className="ord-supplier-note" title={line.supplierNote}>
                {line.supplierNote}
              </span>
            ) : line.supplierAssignable ? (
              // issue 107 bod 3: majiteľ, komentár #1: "neviem čo tam je
              // Priradenie dodávateľa stĺpec" — namiesto holej pomlčky (predtým
              // aj tu, aj v `.ord-supplier-assign` nižšie — DVE pomlčky nad
              // sebou) je tu teraz VIDITEĽNÝ popis toho, čo vstup pod ním robí.
              // Zámerne v TEJTO, už existujúcej bunke (nie nový riadok pod
              // vstupom) — pridanie ĎALŠIEHO riadku by pri úzkom stĺpci
              // (input+button už zapĺňajú takmer celú šírku) posunulo výšku
              // riadku nad issue 105's ~95px invariant (živo zmerané: 85px →
              // 103.5px s popisom na vlastnom riadku).
              <span className="ord-supplier-assign-hint">Priradiť dodávateľa</span>
            ) : (
              // issue 117: `externalCode` (dodávateľský kód) sa už NIKDY
              // nezobrazuje — majiteľ ho nepoužíva ("kody produktov vobec
              // nepouzivame"), appka používa výlučne odkaz na dodávateľa.
              // Predtým sa táto pomlčka potláčala, keď `externalCode` bol
              // vyplnený (zobrazoval sa namiesto nej samostatný "kód …" riadok)
              // — bez toho riadku je terajší terminálny stav VŽDY pomlčka,
              // keď riadok nemá ani odkaz, ani poznámku, ani priradenie
              // (legitímny, `OrderLineRow.supplierAssignCell.test.tsx`).
              "—"
            )}
          </div>
          {/* issue 121: majiteľ, doslovne "ma byt moznost ho doplnit... pri
              kazdom produkte ma byt moznost upravit link". TOGGLE (nie trvalo
              viditeľný vstup) — pridáva JEDEN malý prvok VŽDY (`flex-shrink: 0`
              v `.ord-supplier-row`, žiadna vlastná výška), vstup+uložiť sa
              vykreslí LEN pri otvorenej úprave (nižšie), aby sa nezopakovala
              issue 105/107/111/127's row-height regresia na VŠETKÝCH 37
              riadkoch naraz. */}
          <button
            type="button"
            className="ord-supplier-link-edit-toggle"
            data-testid={`supplier-link-edit-toggle-${line.lineId}`}
            aria-label={
              linkEditing
                ? `Zrušiť úpravu odkazu na dodávateľa — ${line.variantName} (${line.variantCode})`
                : line.supplierUrl !== null
                  ? `Upraviť odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`
                  : `Doplniť odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`
            }
            title={linkEditing ? "Zrušiť úpravu" : line.supplierUrl !== null ? "Upraviť odkaz" : "Doplniť odkaz"}
            onClick={toggleLinkEditing}
          >
            <span aria-hidden="true">{linkEditing ? "✖" : "✏️"}</span>
          </button>
        </div>
        {linkEditing && (
          <div className="ord-supplier-link-edit" data-testid={`supplier-link-edit-${line.lineId}`}>
            <input
              type="url"
              className="ord-supplier-link-edit-input"
              data-testid={`supplier-link-edit-input-${line.lineId}`}
              aria-label={`Odkaz na dodávateľa riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
              placeholder="https://…"
              value={linkDraft}
              disabled={linkBusyHere}
              onChange={(e) => {
                setLinkDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveLink();
                }
              }}
            />
            <button
              type="button"
              className="btn sm good"
              data-testid={`supplier-link-edit-save-${line.lineId}`}
              aria-label={`Uložiť odkaz na dodávateľa riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
              disabled={linkBusyHere || linkDraft.trim() === ""}
              onClick={saveLink}
            >
              💾
            </button>
          </div>
        )}
        {/* pri neradiťeľnom riadku (100 % dnešných ostrých dát) sa TENTO blok
            predtým vykresľoval VŽDY, len s holou pomlčkou "—" bez
            akéhokoľvek významu. Teraz sa nevykreslí VÔBEC (žiadny prvok,
            žiadny prázdny <div>) — presne to, čo test v
            `OrderLineRow.supplierAssignCell.test.tsx` overuje. */}
        {line.supplierAssignable && (
          <div className="ord-supplier-assign" data-testid={`supplier-assign-cell-${line.lineId}`}>
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
          </div>
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
      <td className="ord-date-cell">
        {new Date(line.placedAt).toLocaleDateString("sk-SK")}
        {/* issue 65: upozornenie na starú nevybavenú objednávku — priamy
            náprotivok starej appky's ⚠️ badge (`ordersSummary.ts`'s
            `isStaleOrderLine`, hranica 14 dní). issue 127: viditeľný text
            skrátený na "N d" (namiesto "N dní") — naživo nameraný odznak
            pretŕčal svoju bunku (`.col-date`) o ~22px pri 1280px, keďže
            stĺpec je užší než jeho vlastný obsah. Celý text ("N dní")
            zostáva v `title` tooltipe pre prístupnosť/čitateľnosť. */}
        {isStaleOrderLine(line) && (
          <span
            className="ord-stale-badge"
            data-testid={`stale-badge-${line.lineId}`}
            title={`Nevybavená objednávka stará ${String(orderLineAgeDays(line.placedAt))} dní — pozri, nech nezapadne`}
          >
            ⚠️ {orderLineAgeDays(line.placedAt)} d
          </span>
        )}
      </td>
      {/* issue 95: POZNÁMKA E-SHOPU (`remark`, read-only) + KOMENTÁR zlúčené
          do jednej bunky "Poznámky" (majiteľ, komentár #10) — oba vnorené
          bloky nižšie sú BEZ ZMENY (rovnaké testid, rovnaká logika), len pod
          sebou v jednej `<td>` namiesto dvoch samostatných stĺpcov. */}
      <td className="ord-notes-merged">
        {/* issue 65: zákaznícky odkaz k objednávke — read-only, appka ho
            nikdy needituje (na rozdiel od `comment` bloku nižšie). */}
        {/* issue 111 bod 4: predtým sa tu VŽDY vykresľovala holá pomlčka "—",
            keď objednávka nemá poznámku e-shopu (100 % dnešných ostrých dát)
            — presne ten istý zbytočný riadok navyše, aký #107 bod 3 už
            odstránilo z priradenia dodávateľa. Keď `remark` je `null`,
            nevykreslí sa NIČ (žiadny prvok, žiadny prázdny <span>) —
            `OrderLineRow.remarkCell.test.tsx` to overuje. */}
        <div className="ord-remark-cell" data-testid={`remark-cell-${line.lineId}`}>
          {line.remark !== null && (
            <span className="ord-remark" title={line.remark}>
              🛈 {line.remark}
            </span>
          )}
        </div>
        <div className="ord-comment-cell" data-testid={`comment-cell-${line.lineId}`}>
          {canChangeState ? (
            <>
              <input
                type="text"
                className="ord-comment-input"
                data-testid={`comment-input-${line.lineId}`}
                aria-label={`Poznámka k objednávke ${line.externalOrderId} / ${line.variantCode}`}
                placeholder="poznámka…"
                maxLength={2000}
                value={commentDraft}
                disabled={commentBusyHere}
                onChange={(e) => {
                  isCommentDirty.current = true;
                  setCommentDraft(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveComment();
                  }
                }}
              />
              <button
                type="button"
                className="btn sm good"
                data-testid={`comment-save-${line.lineId}`}
                aria-label={`Uložiť poznámku k objednávke ${line.externalOrderId} / ${line.variantCode}`}
                disabled={commentBusyHere}
                onClick={saveComment}
              >
                💾
              </button>
            </>
          ) : (
            (line.comment ?? "—")
          )}
        </div>
      </td>
    </tr>
  );
}
