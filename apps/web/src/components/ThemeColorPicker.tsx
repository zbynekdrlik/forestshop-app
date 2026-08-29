import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import type { Me } from "../api.js";
import { applyThemeColors } from "../applyThemeColors.js";
import { fetchThemeColors, resetThemeColors, saveThemeColors, ThemeColorsUnauthorizedError, type ThemeColor } from "../themeColorsApi.js";
import { useStaleResponseGuard } from "../useStaleResponseGuard.js";

// issue 264, majiteľ: "koliesko vpravo hore, vyskakovacie okno, naživo ako
// bude ťahať farbu po palete tak sa mu to bude meniť na stránke". Viditeľné
// len pre role, čo smú aj uložiť (`requireRole("admin","manazer")` na
// serveri) — rovnaký `CONTROL_ROLES`-štýl gate ako `MailTemplatesSection.tsx`
// (issue 192), len tu rovno skryje CELÉ tlačidlo namiesto len uzamknutia
// polí, keďže čítať tieto farby na tomto mieste netreba (App.tsx ich už
// premietne pri prihlásení pre KAŽDÉHO používateľa).
const EDIT_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface ThemeColorGroup {
  readonly title: string;
  readonly sampleLabel: string;
  readonly bgKey: string;
  readonly textKey: string;
}

const GROUPS: readonly ThemeColorGroup[] = [
  { title: "Vybavený dodávateľ", sampleLabel: "Vybavené", bgKey: "chip-done-bg", textKey: "chip-done-text" },
  { title: "Nespracovaný dodávateľ", sampleLabel: "Nespracované", bgKey: "chip-todo-bg", textKey: "chip-todo-text" },
  { title: "Práve zvolená bublinka", sampleLabel: "Zvolené", bgKey: "chip-active-bg", textKey: "chip-active-text" },
];

function ThemeColorField({
  id,
  label,
  value,
  invalid,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="themecolor-field">
      <span className="themecolor-field-label">{label}</span>
      <span className="themecolor-field-inputs">
        <input
          type="color"
          value={HEX_RE.test(value) ? value : "#000000"}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          data-testid={`themecolor-swatch-${id}`}
          aria-label={`${label} — paleta`}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          data-testid={`themecolor-hex-${id}`}
          aria-label={`${label} — kód farby`}
          aria-invalid={invalid}
          maxLength={7}
          className="themecolor-hex-input"
        />
      </span>
    </label>
  );
}

export function ThemeColorPicker({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [colors, setColors] = useState<readonly ThemeColor[] | null>(null);
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const [baseline, setBaseline] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Code review finding: close→reopen before the FIRST fetch resolves could
  // let the STALE response's `.then()` land after a newer one and overwrite
  // state with old values (same "latest wins" class of race as issue 151/251,
  // `.claude/rules/frontend-design.md`) — each `openPicker()` bumps this and
  // the `.then()` only applies if it is still the most recent request.
  const guard = useStaleResponseGuard();

  // Code review finding: closing (Escape/backdrop/Cancel) WHILE a save/reset
  // request is in flight reverted the live CSS preview to `baseline`
  // immediately, but the in-flight request's OWN success handler (below)
  // never re-applied its result — the page could keep showing the OLD
  // colours even though the server (and this component's `baseline`) already
  // has the NEW ones. Making `close()` a no-op while `busy` removes the race
  // entirely: the dialog can only close once the request has settled, and
  // both the save/reset success handlers close it themselves at that point.
  const close = useCallback(() => {
    if (busy) return;
    applyThemeColors(baseline);
    setOpen(false);
  }, [busy, baseline]);

  // Esc zavrie dialóg rovnako ako "Zrušiť" (vráti pôvodné farby) — rovnaký
  // vzor ako `MailPreviewDialog.tsx` (issue 191).
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // Fokus do dialógu pri otvorení, späť na spúšťacie tlačidlo pri zavretí.
  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus();
    return () => {
      const target = previousFocusRef.current;
      if (target !== null && target.isConnected) target.focus();
    };
  }, [open]);

  if (!EDIT_ROLES.has(role)) return null;

  function openPicker(e: MouseEvent<HTMLButtonElement>): void {
    previousFocusRef.current = e.currentTarget;
    setError("");
    // Code review finding: without resetting these, a reopen whose refetch
    // fails (network hiccup) would silently keep rendering the PREVIOUS
    // session's draft/baseline as if fresh — `colors !== null` would skip the
    // "Načítavam…" state and Save could re-persist a stale draft unnoticed.
    setColors(null);
    setDraft({});
    setBaseline({});
    setOpen(true);
    const seq = guard.begin();
    fetchThemeColors()
      .then((list) => {
        if (!guard.isLatest(seq)) return; // closed+reopened while this was in flight — a newer fetch already applied its own state
        setColors(list);
        const values = Object.fromEntries(list.map((c) => [c.key, c.value]));
        setDraft(values);
        setBaseline(values);
        applyThemeColors(values);
      })
      .catch((err: unknown) => {
        if (!guard.isLatest(seq)) return;
        if (err instanceof ThemeColorsUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Farby aplikácie sa nepodarilo načítať.");
      });
  }

  function setValue(key: string, value: string): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (HEX_RE.test(value)) applyThemeColors({ [key]: value });
  }

  function save(): void {
    setBusy(true);
    setError("");
    saveThemeColors(draft)
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setBaseline(draft);
        setOpen(false);
      })
      .catch((err: unknown) => {
        setBusy(false);
        if (err instanceof ThemeColorsUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Uloženie farieb zlyhalo.");
      });
  }

  function resetToDefaults(): void {
    setBusy(true);
    setError("");
    resetThemeColors()
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (colors === null) return;
        const defaults = Object.fromEntries(colors.map((c) => [c.key, c.defaultValue]));
        setDraft(defaults);
        setBaseline(defaults);
        applyThemeColors(defaults);
      })
      .catch(() => {
        setBusy(false);
        setError("Vrátenie predvolených farieb zlyhalo.");
      });
  }

  const allValid = Object.keys(draft).length > 0 && Object.values(draft).every((v) => HEX_RE.test(v));
  const dirty = Object.keys(baseline).some((key) => baseline[key] !== draft[key]);
  // issue 264 živé overenie (0.3.0-dev.153): neplatný kód farby len ticho
  // blokoval Uložiť, majiteľ sa nedozvedel prečo ani ktoré pole je zlé.
  // Odvodené priamo z `draft` (rovnaký princíp ako `allValid`/`dirty` vyššie)
  // — žiadny extra `useState`, zmizne samo, len čo sa hodnota opraví.
  const invalidKeys = new Set(Object.entries(draft).filter(([, v]) => !HEX_RE.test(v)).map(([key]) => key));

  return (
    <>
      <button type="button" className="themecolor-btn" aria-label="Farby aplikácie" title="Farby aplikácie" data-testid="themecolor-btn" onClick={openPicker}>
        🎨
      </button>
      {open && (
        <div
          className="modal-backdrop"
          data-testid="themecolor-dialog-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="themecolor-dialog-title" tabIndex={-1} ref={panelRef} data-testid="themecolor-dialog">
            <h3 id="themecolor-dialog-title" className="modal-title">
              Farby aplikácie
            </h3>
            <p className="modal-meta">Farby bublinek dodávateľov v „Na objednanie“ — zmena sa prejaví na stránke okamžite, aj počas ťahania paletou.</p>
            {error !== "" && (
              <p role="alert" data-testid="themecolor-error">
                {error}
              </p>
            )}
            {invalidKeys.size > 0 && (
              <p role="alert" data-testid="themecolor-hex-invalid">
                Kód farby musí byť v tvare #RRGGBB (napr. #D14D3B).
              </p>
            )}
            {colors === null ? (
              <p>Načítavam…</p>
            ) : (
              <div className="themecolor-groups">
                {GROUPS.map((group) => (
                  <fieldset key={group.title} className="themecolor-group">
                    <legend>{group.title}</legend>
                    <span className="themecolor-sample" style={{ background: draft[group.bgKey], color: draft[group.textKey] }} data-testid={`themecolor-sample-${group.bgKey}`}>
                      {group.sampleLabel}
                    </span>
                    <ThemeColorField id={group.bgKey} label="Pozadie" value={draft[group.bgKey] ?? ""} invalid={invalidKeys.has(group.bgKey)} onChange={(v) => { setValue(group.bgKey, v); }} />
                    <ThemeColorField id={group.textKey} label="Text" value={draft[group.textKey] ?? ""} invalid={invalidKeys.has(group.textKey)} onChange={(v) => { setValue(group.textKey, v); }} />
                  </fieldset>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn lg good" disabled={busy || !dirty || !allValid} onClick={save} data-testid="themecolor-save">
                Uložiť
              </button>
              <button type="button" className="btn lg ghost" disabled={busy} onClick={close} data-testid="themecolor-cancel">
                Zrušiť
              </button>
              <button type="button" className="btn lg ghost" disabled={busy || colors === null} onClick={resetToDefaults} data-testid="themecolor-reset">
                Obnoviť predvolené
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
