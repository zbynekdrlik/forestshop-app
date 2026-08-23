import { useEffect, useRef, useState, type JSX, type RefObject } from "react";

// issue 440: vloženie emoji do textu (Poznámky + Nové upozornenie). Emoji sa v
// appke ukladajú aj zobrazujú správne (overené naživo proti Postgresu — Postgres
// `text` + node-postgres nesú 4-bajtové UTF-8, žiadna sanitizácia) — chýbal len
// SPÔSOB, ako ich na desktope vložiť. Toto je malý znovupoužiteľný prepínač s
// kurátorovanou sadou bežných emoji, BEZ ťažkej externej knižnice (MVP).
//
// issue 471: DVA režimy nad TÝM ISTÝM popoverom a zoznamom.
//  - INSERT (predvolený, Poznámky/Upozornenia/text úlohy): klik vloží emoji na
//    pozíciu kurzora cieľového poľa a vráti fokus + kurzor zaň.
//  - PICK (`onPick`, označenie CELEJ úlohy jedným klikom): klik na emoji rovno
//    zavolá `onPick(emoji)` a popover sa zavrie; voľba „bez emoji" volá
//    `onPick(null)`.

// Kurátorovaná sada bežných emoji pre nástenku obchodu (žiadny externý picker).
// JEDEN zdieľaný zoznam pre všetky použitia (Poznámky, Upozornenia, Úlohy).
// Grid je 8 stĺpcov (`app.css`). issue 471 rozšíril pôvodných 40 (issue 440) o
// 11 emoji z Štěpánovej „Frequently Used" sady — APPEND na koniec, aby sa
// zaužívané pozície prvých 40 nemenili (strop ~60–70 dodržaný).
const EMOJI: readonly string[] = [
  "👍", "👎", "🙂", "😀", "😅", "😂", "😉", "😍",
  "🥰", "😎", "🤔", "😢", "😡", "🎉", "🔥", "⭐",
  "✅", "❌", "⚠️", "❗", "❓", "💡", "📌", "📅",
  "⏰", "📦", "🚚", "💰", "🛒", "📞", "📝", "🙏",
  "👀", "💪", "👌", "✨", "❤️", "🌲", "➡️", "🕒",
  // issue 471 — Štěpánova reálne používaná sada:
  "👏", "🚀", "🥳", "📣", "🤯", "😭", "😆", "🤷",
  "😳", "😜", "🤨",
];

/**
 * Čistá (bez DOM) logika vloženia emoji na pozíciu kurzora — samostatne
 * testovateľná. Vráti novú CELÚ hodnotu poľa a kam má skončiť kurzor (za
 * vloženým emoji). Výber (selStart..selEnd) sa prepíše; pozície sa orežú do
 * platného rozsahu, takže sa dá zavolať aj s "koniec poľa" defaultom, keď pole
 * nebolo fokusnuté.
 */
export function insertEmojiAtSelection(value: string, selStart: number, selEnd: number, emoji: string): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  return { value: value.slice(0, start) + emoji + value.slice(end), cursor: start + emoji.length };
}

interface CommonProps {
  /** Unikátny testid prefix (viac pickerov na obrazovke — inak by `getByTestId`
   * kolidoval). */
  readonly testId: string;
  readonly disabled?: boolean;
  /** Popis prepínača (aria-label + title). Predvolene „Vložiť emoji"; riadkové
   * označenie úlohy použije napr. „Pridať/zmeniť emoji". */
  readonly label?: string;
}

/** Predvolený INSERT režim — vloženie na pozíciu kurzora cieľového poľa. */
interface InsertProps extends CommonProps {
  readonly targetRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onPick?: undefined;
  readonly showClear?: undefined;
  readonly align?: undefined;
}

/** PICK režim — klik na emoji rovno zavolá `onPick` (bez cieľového poľa). */
interface PickProps extends CommonProps {
  readonly onPick: (emoji: string | null) => void;
  /** Zobraziť voľbu „bez emoji" (→ `onPick(null)`). */
  readonly showClear?: boolean;
  /** „right" ukotví popover k PRAVÉMU okraju prepínača — pre picker pri pravom
   * okraji riadku (inak by sa `left:0` popover roztiahol mimo panela). */
  readonly align?: "left" | "right";
  readonly targetRef?: undefined;
  readonly value?: undefined;
  readonly onChange?: undefined;
}

type Props = InsertProps | PickProps;

export function EmojiPickerButton(props: Props): JSX.Element {
  const { testId, disabled = false, label = "Vložiť emoji" } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  // rAF na obnovu fokusu po vložení — držaný v refe, nech ho vieme zrušiť pri
  // ďalšom inserte aj pri odmountovaní (issue 455: oneskorený rAF nesmie
  // ukradnúť fokus tam, kam sa používateľ medzičasom presunul). Používa sa len
  // v INSERT režime.
  const rafRef = useRef<number | null>(null);

  // Zruš čakajúci rAF na obnovu fokusu pri odmountovaní (napr. zatvorení
  // formulára), nech oneskorená snímka neukradne fokus po zmiznutí poľa.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Popover neblokuje zvyšok formulára — zavrie sa na klik mimo a na Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (rootRef.current !== null && target instanceof Node && !rootRef.current.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // INSERT režim — vloženie na pozíciu kurzora. V PICK režime sa nikdy nevolá
  // (skorý return zároveň zúži `props` na `InsertProps`).
  const insert = (emoji: string): void => {
    if (props.onPick !== undefined) return;
    const el = props.targetRef.current;
    // Bázová hodnota = ŽIVÁ DOM hodnota poľa (`el.value`), nie React `value`
    // prop. Prop je snímka z posledného renderu a vie zaostať za tým, čo
    // používateľ reálne napísal, keď React ešte neskomitoval onChange poľa
    // (issue 455: na inak časovanom CI runneri emoji klik bežal skôr, než sa
    // update stavu z predošlého `.fill()` prejavil, takže zastaraný prázdny
    // prop prepísal napísaný text — DOM hodnota je vždy aktuálna). Výber sa
    // číta z TOHO ISTÉHO elementu, takže hodnota + caret sú jedna konzistentná
    // snímka. Na prop spadneme len keď element neexistuje.
    const base = el !== null ? el.value : props.value;
    const selStart = el?.selectionStart ?? base.length;
    const selEnd = el?.selectionEnd ?? base.length;
    const { value: next, cursor } = insertEmojiAtSelection(base, selStart, selEnd, emoji);
    props.onChange(next);
    // Popover sa po vložení ZAVRIE — je `position: absolute` a otvára sa NAD
    // obsahom pod ním (napr. tlačidlo Uložiť leží pod poľom); keby ostal
    // otvorený, jeho dlaždice by prekryli a "ukradli" klik na Uložiť (nájdené
    // e2e testom). Ďalšie emoji = znova otvoriť (štandardné správanie ľahkého
    // pickeru). Kurzor sa nastaví AŽ v `requestAnimationFrame` — kontrolovaná
    // hodnota sa prekreslí až po commite Reactu, vtedy DOM už nesie novú
    // hodnotu a `setSelectionRange` sadne správne; fokus sa vráti do poľa, aby
    // sa dalo písať ďalej.
    setOpen(false);
    // Oneskorený rAF nesmie UKRADNÚŤ fokus: na zaťaženom (CI) stroji vystrelí až
    // keď sa používateľ — alebo Playwright `.fill()` iného poľa, čo je dvojkroková
    // focus→insertText operácia — medzičasom presunul inam. Bezpodmienečný
    // `target.focus()` by vtedy skočil späť na naše pole a text by sa napísal do
    // zlého poľa (issue 455). Fokus vráť LEN keď je stále „náš" — aktívny prvok
    // je pole samo, náš popover/root, `<body>` alebo `null`. Predošlý čakajúci
    // rAF zrušíme.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const target = props.targetRef.current;
      if (target === null) return;
      const active = document.activeElement;
      const ours =
        active === null ||
        active === document.body ||
        active === target ||
        (rootRef.current !== null && rootRef.current.contains(active));
      if (!ours) return;
      target.focus();
      target.setSelectionRange(cursor, cursor);
    });
  };

  const choose = (emoji: string): void => {
    if (props.onPick !== undefined) {
      // PICK režim: jeden klik = hotovo, popover sa zavrie.
      setOpen(false);
      props.onPick(emoji);
      return;
    }
    insert(emoji);
  };

  const alignRight = props.onPick !== undefined && props.align === "right";
  const showClear = props.onPick !== undefined && props.showClear === true;

  return (
    <span className="emoji-picker" ref={rootRef}>
      <button
        type="button"
        className="emoji-picker-toggle"
        aria-label={label}
        aria-expanded={open}
        title={label}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
        }}
        data-testid={testId}
      >
        😊
      </button>
      {open && (
        // `role="group"` (nie `menu`) + `aria-label` — čestný ARIA: je to
        // pomenovaná skupina obyčajných tlačidiel, nie aplikačné menu s
        // roving-focus/šípkovou navigáciou (tú tento MVP picker neimplementuje;
        // ovládanie je myš + Tab/Enter na natívnych `<button>`och).
        <div
          className={"emoji-picker-popover" + (alignRight ? " align-right" : "")}
          role="group"
          aria-label="Emoji na vloženie"
          data-testid={`${testId}-popover`}
        >
          {showClear && (
            <button
              type="button"
              className="emoji-picker-clear"
              aria-label="Bez emoji"
              title="Odstrániť emoji"
              data-testid={`${testId}-clear`}
              onClick={() => {
                // `props` je tu už zúžené na PickProps (cez alias `showClear`),
                // takže `onPick` je vždy definované.
                setOpen(false);
                props.onPick(null);
              }}
            >
              bez emoji
            </button>
          )}
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="emoji-picker-option"
              aria-label={`Vložiť ${emoji}`}
              title={emoji}
              onClick={() => {
                choose(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
