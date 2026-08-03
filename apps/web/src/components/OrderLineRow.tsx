import { useEffect, useRef, useState, type JSX } from "react";
import type { OrderLine } from "../ordersApi.js";
import { STATE_LABELS } from "../orderLineStateLabels.js";
import { formatVariantTotalChip, isStaleOrderLine, orderLineAgeDays, type VariantTotal } from "../ordersSummary.js";
import { OrderLineStateButtons } from "./OrderLineStateButtons.js";

// issue 162: počet stĺpcov "Na objednanie" tabuľky — MUSÍ sedieť s počtom
// `<col>` v `SupplierOrderGroup.tsx`'s `<colgroup>` (9). Vlastný rozbaľovací
// riadok pod týmto riadkom (odkaz na dodávateľa, nižšie) potrebuje `colSpan`
// cez CELÚ šírku tabuľky — ak niekedy pribudne/ubudne stĺpec v tamojšom
// `<colgroup>`, toto číslo treba zmeniť s ním (žiadny automatický zdroj
// pravdy, len tento komentár + grep na `colSpan`).
const ORDERS_TABLE_COLUMN_COUNT = 9;

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
  pendingSupplierDraft,
  onChangeState,
  onChangeOrdered,
  onAssignSupplier,
  onSetSupplierLink,
  onChangeComment,
  onEditorActivityChange,
  onSupplierDraftChange,
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
  // issue 151: rozpísaný, ešte neuložený koncept priradenia dodávateľa —
  // žije v `OrdersSection.tsx`'s `useSupplierDrafts.ts`, NIE lokálne tu
  // (`useSupplierDrafts.ts` vysvetľuje prečo: priradenie mení SKUPINU
  // riadku, takže lokálny stav v tejto komponente presun medzi skupinami
  // neprežije). `undefined`, keď tento riadok nemá rozpísaný koncept —
  // vtedy sa zobrazuje priamo `line.manualSupplierOverride`.
  readonly pendingSupplierDraft: string | undefined;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
  readonly onAssignSupplier: (lineId: string, supplier: string) => void;
  // issue 121: manuálny odkaz na dodávateľa — smie sa upraviť pri KAŽDOM
  // riadku (na rozdiel od `onAssignSupplier`, ktorý je len pre riadky bez
  // katalógového dodávateľa). issue 166: vracia `boolean` — `true` keď vstup
  // prešiel validáciou a zápis sa spustil, `false` keď bol okamžite
  // odmietnutý (`saveLink` nižšie podľa toho rozhoduje, či zavrieť editor).
  readonly onSetSupplierLink: (lineId: string, url: string) => boolean;
  readonly onChangeComment: (orderId: string, comment: string | null) => void;
  // issue 149: hlási RODIČOVI (`OrdersSection.tsx`'s `dirtyEditorLineIds`),
  // či tento riadok PRÁVE TERAZ drží otvorenú/rozpísanú úpravu — výnimka z
  // "skryť vybavené" filtra, aby riadok nezmizol spod rúk. Nesie len boolean,
  // nikdy samotný rozpísaný text (ten ostáva výlučne tu, v tomto komponente).
  readonly onEditorActivityChange: (lineId: string, active: boolean) => void;
  // issue 151: hlási RODIČOVI (`OrdersSection.tsx`'s `useSupplierDrafts.ts`)
  // KAŽDÚ zmenu rozpísaného konceptu priradenia dodávateľa — na rozdiel od
  // `onEditorActivityChange` vyššie (len boolean) tu ide o SAMOTNÝ TEXT,
  // lebo ten musí prežiť aj presun riadku medzi skupinami (remount).
  readonly onSupplierDraftChange: (lineId: string, value: string) => void;
}): JSX.Element {
  const qtyChip = variantTotal !== undefined ? formatVariantTotalChip(variantTotal) : null;

  // issue 63 + issue 151: zobrazovaná hodnota je ODVODENÁ z props, nie
  // lokálny stav — `pendingSupplierDraft` (rodičovská mapa, prežije presun
  // riadku medzi skupinami) má prednosť pred potvrdenou hodnotou zo servera.
  // Žiadny `useState`/reset `useEffect`/dirty ref tu netreba: keď rodič
  // nedrží rozpísaný koncept (`undefined`), zobrazí sa priamo
  // `line.manualSupplierOverride`; keď drží, zobrazí sa TEN, bez ohľadu na
  // to, či ide o re-render TEJ ISTEJ inštancie, alebo o čerstvo namontovanú
  // (rodič zosúlaďuje/čistí mapu sám, `useSupplierDrafts.ts`'s `reconcile`).
  const supplierDraft = pendingSupplierDraft ?? (line.manualSupplierOverride ?? "");
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
  // OPTIMISTICKÉ len voči ASYNC zlyhaniu zápisu na server (nemožno vedieť
  // vopred) — vtedy ostáva chyba viditeľná v kumulatívnom `writeFailures`
  // banneri, manažér otvorí úpravu znova. issue 166: voči SYNCHRÓNNEJ
  // klientskej validácii (`onSetSupplierLink`'s návratová hodnota) sa
  // NEZATVÁRA — jej výsledok je známy ešte PRED zavretím, takže `saveLink`
  // zatvára editor LEN keď bol vstup prijatý; pri odmietnutí ostáva otvorený
  // so zachovaným textom (predtým sa zatváral vždy, bez ohľadu na výsledok).
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
    const accepted = onSetSupplierLink(line.lineId, trimmed);
    if (accepted) {
      setLinkEditing(false);
    }
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

  // issue 149: "má tento riadok otvorenú/rozpísanú úpravu" — presne tie tri
  // editory, ktoré ticket menuje. `linkEditing` počíta ako aktívny hneď pri
  // OTVORENÍ (bez ohľadu na obsah, rovnaký zámer ako stará appka's "opened
  // counts as his"); `supplierDraft`/komentár počítajú len keď sa SKUTOČNE
  // líšia od uloženej hodnoty (nemajú vlastný toggle open/close).
  const trimmedSupplierDraft = supplierDraft.trim();
  const supplierDraftDirty =
    line.supplierAssignable && trimmedSupplierDraft !== "" && trimmedSupplierDraft !== (line.manualSupplierOverride ?? "");
  // Code review (PR 154): `isCommentDirty.current` je REF, nie state — jeho
  // čítanie tu funguje len preto, že KAŽDÁ jeho mutácia (`onChange` nižšie →
  // `true`, `saveComment` vyššie → `false`) je v TEJ ISTEJ tikni sprevádzaná
  // state zmenou, ktorá tento komponent aj tak prekreslí (lokálny
  // `setCommentDraft`, alebo rodičovský `setBusyCommentOrderId` cez props) —
  // a nič v tomto strome dnes nie je `React.memo`. Ak by niekedy pribudol
  // `React.memo` na `OrderLineRow`/`SupplierOrderGroup` (perf krok kvôli
  // `dirtyEditorLineIds` nižšie), TENTO odvodený signál by mohol prestať
  // reagovať na správnom tiku bez chyby/varovania — over najprv toto miesto.
  const commentDirtyNow = isCommentDirty.current;
  const hasOpenEditor = linkEditing || supplierDraftDirty || commentDirtyNow;
  useEffect(() => {
    onEditorActivityChange(line.lineId, hasOpenEditor);
    return () => {
      onEditorActivityChange(line.lineId, false);
    };
  }, [line.lineId, hasOpenEditor, onEditorActivityChange]);

  return (
    <>
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
        {/* issue 171: majiteľ, doslovne "poznamka zakaznika daj pod text
            produktu" — zákaznícka poznámka (🛈, `remark`) sa vzťahuje na
            TENTO produkt, nie na "poznámky" všeobecne, takže sa presunula
            sem z bývalej zlúčenej `td.ord-notes-merged` (issue 95/164) do
            VLASTNEJ bunky produktu, ako druhý block-level `<div>` pod menom.
            Rovnaký `<div data-testid="remark-cell-<id>">` (beze zmeny
            testid/logiky — obalový div VŽDY, vnútorný `<span>` len keď
            `remark` nie je `null`, presne vzor issue 111 bod 4/issue 164) —
            len iný rodič. Žiadny `display:flex` na `<td>` (issue 163's
            poučenie, `.claude/rules/frontend-design.md`) — dva stackované
            block divy sa prirodzene poukladajú pod seba bez toho. */}
        <td>
          <div className="ord-product-name">
            {line.variantName}
            {/* issue 187: veľkosť, ktorú zákazník naozaj objednal — obsluha
                podľa nej objednáva u dodávateľa. Kedysi bola vo VLASTNOM
                stĺpci VEĽKOSŤ, issue 95 ju zlúčilo do stĺpca KÓD a issue 117
                celý ten stĺpec odstránilo (kódy sa nepoužívajú), čím veľkosť
                nechcene zmizla. Vracia sa PRI MENE, nie ako stĺpec — tabuľka
                je na šírku napnutá (issue 105/107/111/127). Jednovariantný
                produkt `sizeLabel` nemá: vtedy sa nevykreslí NIČ, žiadna
                pomlčka ani prázdne miesto (zadanie majiteľa). */}
            {line.sizeLabel !== null && (
              <span className="ord-size" data-testid={`size-${line.lineId}`}>
                {line.sizeLabel}
              </span>
            )}
          </div>
          <div className="ord-remark-cell" data-testid={`remark-cell-${line.lineId}`}>
            {line.remark !== null && (
              <span className="ord-remark" title={line.remark}>
                🛈 {line.remark}
              </span>
            )}
          </div>
        </td>
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
                  onSupplierDraftChange(line.lineId, e.target.value);
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
            <OrderLineStateButtons line={line} busyLineId={busyLineId} onChangeState={onChangeState} />
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
        {/* issue 95: POZNÁMKA E-SHOPU (`shopRemark`, read-only) + KOMENTÁR
            zlúčené do jednej bunky "Poznámky" (majiteľ, komentár #10) — oba
            vnorené bloky nižšie sú BEZ ZMENY (rovnaké testid, rovnaká
            logika), len pod sebou v jednej `<td>` namiesto dvoch
            samostatných stĺpcov. issue 171: zákaznícka poznámka (`remark`)
            sa TU už nevykresľuje — presunula sa do bunky produktu, viď
            komentár tam. */}
        <td className="ord-notes-merged">
          {/* issue 164: INTERNÁ poznámka e-shopu — LEN cudzí text (appkin
              vlastný blok už odstránený na strane servera), read-only, nikdy
              needitovateľná — appka na ňu nemá žiadnu zápisovú cestu vôbec.
              issue 111 bod 4's vzor (obalový <div> sa vykresľuje VŽDY,
              vnútorný <span> len keď je poznámka vyplnená — žiadna holá
              pomlčka). issue 171: teraz PRVÝ blok v tejto bunke (predtým
              druhý, za zákazníckou poznámkou, ktorá sa odsťahovala) —
              stráca svoj bývalý `margin-top` (`app.css`). */}
          <div className="ord-shop-remark-cell" data-testid={`shop-remark-cell-${line.lineId}`}>
            {line.shopRemark != null && line.shopRemark !== "" && (
              <span className="ord-shop-remark" title={line.shopRemark}>
                🏪 {line.shopRemark}
              </span>
            )}
          </div>
          <div className="ord-comment-cell" data-testid={`comment-cell-${line.lineId}`}>
            {canChangeState ? (
              <>
                {/* issue 150: `<textarea>` (nie `<input>`) — Enter vkladá nový
                    riadok defaultne (žiadny `preventDefault`), uloží LEN
                    Ctrl/⌘+Enter. Poznámka býva viacriadková (dohoda so
                    zákazníkom/dodávateľom) a spätne sa zapisuje do Shoptetu,
                    takže formátovanie má význam — `<input>` by nový riadok
                    nikdy vizuálne nezobrazil, bez ohľadu na to, čo je v jeho
                    hodnote uložené. */}
                <textarea
                  className="ord-comment-input"
                  data-testid={`comment-input-${line.lineId}`}
                  aria-label={`Poznámka k objednávke ${line.externalOrderId} / ${line.variantCode}`}
                  placeholder="poznámka…"
                  maxLength={2000}
                  rows={1}
                  value={commentDraft}
                  disabled={commentBusyHere}
                  onChange={(e) => {
                    isCommentDirty.current = true;
                    setCommentDraft(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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
                  title="Uložiť poznámku (Ctrl+Enter)"
                  disabled={commentBusyHere}
                  onClick={saveComment}
                >
                  💾
                </button>
              </>
            ) : (
              // issue 150: `.ord-comment-display` (CSS `white-space: pre-wrap`)
              // — už uložený viacriadkový komentár zobrazí svoje zalomenia aj
              // na čítanie, nielen počas úpravy.
              <span className="ord-comment-display">{line.comment ?? "—"}</span>
            )}
          </div>
        </td>
      </tr>
      {/* issue 162: majiteľ, políčko na úpravu odkazu na dodávateľa bolo v
          úzkej bunke DODÁVATEĽ (~94px) príliš malé na to, aby bolo vidno
          reálny odkaz. Namiesto rozširovania úzkeho stĺpca (rozbilo by
          starostlivo odmerané `<colgroup>` rozpočty z issue 107/111/127) sa
          úprava rozbaľuje do VLASTNÉHO riadku POD daným riadkom, cez celú
          šírku tabuľky (`colSpan={ORDERS_TABLE_COLUMN_COUNT}`) — ticketov
          vlastný odporúčaný prístup. Vnútri je PRESNE ten istý, nezmenený
          `<div data-testid="supplier-link-edit-<lineId>">` blok ako predtým
          (rovnaké testid vstupu/uloženia) — `.ord-supplier-link-edit-input`
          už dnes má `flex: 1 1 0%; max-width: 100%` (`app.css`), takže sa
          prirodzene roztiahne na šírku tohto oveľa širšieho rodiča bez
          akejkoľvek zmeny CSS triedy, len zmenou DOM umiestnenia. Testid
          tohto riadku ZÁMERNE nezačína "order-line-" — viacero e2e testov v
          appke používa `[data-testid^='order-line-']` na nájdenie
          HLAVNÉHO riadku (napr. `orders-hidden-editor.spec.ts`); prefix
          zhodný s hlavným riadkom by spôsobil Playwright strict-mode
          koliziu (2 zhodné prvky) hneď, ako by editor bol otvorený. */}
      {linkEditing && (
        <tr className="ord-supplier-link-edit-row" data-testid={`link-edit-row-${line.lineId}`}>
          <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>
            <div className="ord-supplier-link-edit" data-testid={`supplier-link-edit-${line.lineId}`}>
              <input
                type="url"
                className="ord-supplier-link-edit-input"
                data-testid={`supplier-link-edit-input-${line.lineId}`}
                aria-label={`Odkaz na dodávateľa riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
                placeholder="https://…"
                value={linkDraft}
                disabled={linkBusyHere}
                autoFocus
                onChange={(e) => {
                  setLinkDraft(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveLink();
                    return;
                  }
                  // issue 162: majiteľ žiada explicitne "zrušenie (Escape)" —
                  // predtým NEEXISTOVALO na tomto ani žiadnom inom editore v
                  // appke (zrušiť sa dalo len klikom na ✖ toggle); lacné
                  // pridať na presne ten istý vstup, ktorý sa práve presúva.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    toggleLinkEditing();
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
          </td>
        </tr>
      )}
    </>
  );
}
