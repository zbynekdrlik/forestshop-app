import { useEffect, useRef, useState, type JSX, type RefObject } from "react";

// issue 440: vloženie emoji do textu (Poznámky + Nové upozornenie). Emoji sa v
// appke ukladajú aj zobrazujú správne (overené naživo proti Postgresu — Postgres
// `text` + node-postgres nesú 4-bajtové UTF-8, žiadna sanitizácia) — chýbal len
// SPÔSOB, ako ich na desktope vložiť. Toto je malý znovupoužiteľný prepínač s
// kurátorovanou sadou bežných emoji, BEZ ťažkej externej knižnice (MVP). Klik na
// emoji ju vloží na pozíciu kurzora cieľového poľa a vráti fokus + kurzor zaň.

// Kurátorovaná sada bežných emoji pre nástenku obchodu (žiadny externý picker).
// Grid je 8 stĺpcov (`app.css`), takže násobky 8 vyzerajú vyrovnane.
const EMOJI: readonly string[] = [
  "👍", "👎", "🙂", "😀", "😅", "😂", "😉", "😍",
  "🥰", "😎", "🤔", "😢", "😡", "🎉", "🔥", "⭐",
  "✅", "❌", "⚠️", "❗", "❓", "💡", "📌", "📅",
  "⏰", "📦", "🚚", "💰", "🛒", "📞", "📝", "🙏",
  "👀", "💪", "👌", "✨", "❤️", "🌲", "➡️", "🕒",
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

interface Props {
  readonly targetRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Unikátny testid prefix (viac pickerov na obrazovke, napr. dva vo formulári
   * upozornenia) — inak by `getByTestId` kolidoval. */
  readonly testId: string;
  readonly disabled?: boolean;
}

export function EmojiPickerButton({ targetRef, value, onChange, testId, disabled = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  // rAF na obnovu fokusu po vložení — držaný v refe, nech ho vieme zrušiť pri
  // ďalšom inserte aj pri odmountovaní (issue 455: oneskorený rAF nesmie
  // ukradnúť fokus tam, kam sa používateľ medzičasom presunul).
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

  const insert = (emoji: string): void => {
    const el = targetRef.current;
    // Bázová hodnota = ŽIVÁ DOM hodnota poľa (`el.value`), nie React `value`
    // prop. Prop je snímka z posledného renderu a vie zaostať za tým, čo
    // používateľ reálne napísal, keď React ešte neskomitoval onChange poľa
    // (issue 455: na inak časovanom CI runneri emoji klik bežal skôr, než sa
    // update stavu z predošlého `.fill()` prejavil, takže zastaraný prázdny
    // prop prepísal napísaný text — DOM hodnota je vždy aktuálna). Výber sa
    // číta z TOHO ISTÉHO elementu, takže hodnota + caret sú jedna konzistentná
    // snímka. Na prop spadneme len keď element neexistuje.
    const base = el !== null ? el.value : value;
    const selStart = el?.selectionStart ?? base.length;
    const selEnd = el?.selectionEnd ?? base.length;
    const { value: next, cursor } = insertEmojiAtSelection(base, selStart, selEnd, emoji);
    onChange(next);
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
    // zlého poľa (issue 455: hlbšia príčina flaku upozornenia.spec.ts:271 — rAF
    // z insertu nadpisu vystrelil počas `.fill()` podrobností a ukradol fokus).
    // Fokus vráť LEN keď je stále „náš" — aktívny prvok je pole samo, náš
    // popover/root, `<body>` alebo `null`. Po `setOpen(false)` sa kliknuté emoji
    // tlačidlo odmountuje a fokus padne na `<body>`, takže bežná cesta (hneď po
    // vložení) sa aj tak refokusne. Predošlý čakajúci rAF zrušíme.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const target = targetRef.current;
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

  return (
    <span className="emoji-picker" ref={rootRef}>
      <button
        type="button"
        className="emoji-picker-toggle"
        aria-label="Vložiť emoji"
        aria-expanded={open}
        title="Vložiť emoji"
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
        <div className="emoji-picker-popover" role="group" aria-label="Emoji na vloženie" data-testid={`${testId}-popover`}>
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="emoji-picker-option"
              aria-label={`Vložiť ${emoji}`}
              title={emoji}
              onClick={() => {
                insert(emoji);
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
