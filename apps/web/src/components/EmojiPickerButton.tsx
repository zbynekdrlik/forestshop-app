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
    const selStart = el?.selectionStart ?? value.length;
    const selEnd = el?.selectionEnd ?? value.length;
    const { value: next, cursor } = insertEmojiAtSelection(value, selStart, selEnd, emoji);
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
    requestAnimationFrame(() => {
      const target = targetRef.current;
      if (target === null) return;
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
        <div className="emoji-picker-popover" role="menu" data-testid={`${testId}-popover`}>
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="emoji-picker-option"
              role="menuitem"
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
