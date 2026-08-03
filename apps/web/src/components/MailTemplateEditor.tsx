import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  fetchMailTemplateHistory,
  fetchMailTemplatePreview,
  MailTemplatesUnauthorizedError,
  resetMailTemplate,
  saveMailTemplate,
  type MailTemplate,
  type MailTemplateHistoryEntry,
} from "../mailTemplatesApi.js";

// issue 192: úprava JEDNÉHO druhu e-mailu. Rodič komponent montuje nanovo pri
// zmene druhu (`key={template.key}`), takže rozpísané znenie sa načíta z props
// v `useState` inicializátore a nepotrebuje žiadny synchronizačný efekt ani
// jeho stráženie (`.claude/rules/frontend-design.md` — efekt sa oplatí len
// pri VŽDY namontovanom vstupe).

const DEBOUNCE_MS = 400;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate())}. ${String(d.getMonth() + 1)}. ${String(d.getFullYear())} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MailTemplateEditor({
  template,
  canEdit,
  onSaved,
  onSessionExpired,
}: {
  readonly template: MailTemplate;
  readonly canEdit: boolean;
  readonly onSaved: () => void;
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<readonly MailTemplateHistoryEntry[] | null>(null);

  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // Do ktorého poľa sa vloží pole vybrané z ponuky — predvolene do tela,
  // pretože tam patrí drvivá väčšina polí.
  const lastFocused = useRef<"subject" | "body">("body");

  const dirty = subject !== template.subject || body !== template.body;

  // Náhľad sa prepočítava na serveri z PRÁVE ROZPÍSANÉHO znenia (ticket:
  // "náhľad na skutočných dátach ešte pri úprave"), s krátkym oneskorením,
  // aby písanie nevolalo server pri každom písmene.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchMailTemplatePreview(template.key, subject, body)
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setPreviewHtml(result.html);
            setPreviewSubject(result.subject);
            setPreviewError("");
          } else {
            setPreviewError(result.error);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof MailTemplatesUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setPreviewError(err instanceof Error ? err.message : "Náhľad sa nepodarilo pripraviť.");
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [template.key, subject, body, onSessionExpired]);

  const insertPlaceholder = useCallback((name: string) => {
    const token = `{{${name}}}`;
    if (lastFocused.current === "subject") {
      const el = subjectRef.current;
      const at = el?.selectionStart ?? null;
      setSubject((prev) => (at === null ? prev + token : prev.slice(0, at) + token + prev.slice(el?.selectionEnd ?? at)));
      el?.focus();
      return;
    }
    const el = bodyRef.current;
    const at = el?.selectionStart ?? null;
    setBody((prev) => (at === null ? prev + token : prev.slice(0, at) + token + prev.slice(el?.selectionEnd ?? at)));
    el?.focus();
  }, []);

  const save = useCallback(() => {
    setBusy(true);
    setSaveError("");
    setSaved(false);
    saveMailTemplate(template.key, subject, body)
      .then((result) => {
        if (result.ok) {
          setSaved(true);
          setHistory(null);
          onSaved();
          return;
        }
        setSaveError(result.error);
      })
      .catch((err: unknown) => {
        if (err instanceof MailTemplatesUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setSaveError(err instanceof Error ? err.message : "Uloženie zlyhalo.");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [template.key, subject, body, onSaved, onSessionExpired]);

  const restoreOriginal = useCallback(() => {
    setBusy(true);
    setSaveError("");
    setSaved(false);
    resetMailTemplate(template.key)
      .then((result) => {
        if (!result.ok) {
          setSaveError(result.error);
          return;
        }
        setSubject(template.defaultSubject);
        setBody(template.defaultBody);
        setHistory(null);
        onSaved();
      })
      .catch((err: unknown) => {
        if (err instanceof MailTemplatesUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setSaveError(err instanceof Error ? err.message : "Vrátenie pôvodného znenia zlyhalo.");
      })
      .finally(() => {
        setBusy(false);
      });
  }, [template.key, template.defaultSubject, template.defaultBody, onSaved, onSessionExpired]);

  const loadHistory = useCallback(() => {
    fetchMailTemplateHistory(template.key)
      .then(setHistory)
      .catch((err: unknown) => {
        if (err instanceof MailTemplatesUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setSaveError(err instanceof Error ? err.message : "Históriu zmien sa nepodarilo načítať.");
      });
  }, [template.key, onSessionExpired]);

  return (
    <div className="mt-editor" data-testid={`mail-template-editor-${template.key}`}>
      <div className="mt-editor-head">
        <h3>{template.label}</h3>
        <p className="mt-editor-desc">{template.description}</p>
        {template.isCustomized ? (
          <p className="pill" data-testid="mail-template-customized">
            Upravené{template.updatedByName === null ? "" : ` — ${template.updatedByName}`}
            {template.updatedAt === null ? "" : `, ${formatDateTime(template.updatedAt)}`}
          </p>
        ) : (
          <p className="pill off" data-testid="mail-template-original">
            Pôvodné znenie
          </p>
        )}
      </div>

      <div className="mt-editor-grid">
        <div className="mt-fields">
          <label className="mt-field">
            <span>Predmet e-mailu</span>
            <input
              ref={subjectRef}
              value={subject}
              disabled={!canEdit || busy}
              onFocus={() => {
                lastFocused.current = "subject";
              }}
              onChange={(e) => {
                setSubject(e.target.value);
                setSaved(false);
              }}
              data-testid="mail-template-subject"
            />
          </label>

          <label className="mt-field">
            <span>Text e-mailu</span>
            <textarea
              ref={bodyRef}
              value={body}
              rows={18}
              disabled={!canEdit || busy}
              onFocus={() => {
                lastFocused.current = "body";
              }}
              onChange={(e) => {
                setBody(e.target.value);
                setSaved(false);
              }}
              data-testid="mail-template-body"
            />
          </label>

          <div className="mt-placeholders">
            <p className="mt-placeholders-title">Polia, ktoré sa doplnia pri odoslaní — kliknutím ich vložíte do textu:</p>
            <div className="mt-chips">
              {template.placeholders.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="btn chip"
                  disabled={!canEdit || busy}
                  title={p.label}
                  onClick={() => {
                    insertPlaceholder(p.name);
                  }}
                  data-testid={`mail-template-chip-${p.name}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-hint">
              Tučné písmo napíšete dvomi hviezdičkami: <code>**takto**</code>. Prázdny riadok začne nový odstavec.
            </p>
          </div>

          {saveError !== "" && (
            <p role="alert" data-testid="mail-template-error">
              {saveError}
            </p>
          )}
          {saved && !dirty && (
            <p role="status" data-testid="mail-template-saved">
              Znenie je uložené. Odteraz sa posiela takto.
            </p>
          )}

          {canEdit && (
            <div className="mt-actions">
              <button type="button" className="btn lg good" disabled={busy || !dirty} onClick={save} data-testid="mail-template-save">
                💾 Uložiť znenie
              </button>
              <button type="button" className="btn lg ghost" disabled={busy || !template.isCustomized} onClick={restoreOriginal} data-testid="mail-template-reset">
                ↩ Vrátiť pôvodné znenie
              </button>
              <button type="button" className="btn lg ghost" onClick={loadHistory} data-testid="mail-template-history-load">
                🕓 História zmien
              </button>
            </div>
          )}
        </div>

        <div className="mt-preview">
          <p className="mt-preview-title">Náhľad na skutočných údajoch</p>
          {previewError === "" ? (
            <>
              <p className="mt-preview-subject" data-testid="mail-template-preview-subject">
                Predmet: {previewSubject}
              </p>
              {/* `previewHtml` generuje SERVER z tejto šablóny — hodnoty polí
                  sú tam už escapované (`mail-templates/render.ts`), nikdy sa
                  sem nevkladá surový vstup používateľa priamo. */}
              <div className="mt-preview-body" data-testid="mail-template-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </>
          ) : (
            <p role="alert" data-testid="mail-template-preview-error">
              {previewError}
            </p>
          )}
        </div>
      </div>

      {history !== null && (
        <div className="mt-history" data-testid="mail-template-history">
          <h4>História zmien</h4>
          {history.length === 0 ? (
            <p>Zatiaľ žiadna zmena — platí pôvodné znenie.</p>
          ) : (
            <ul>
              {history.map((entry) => (
                <li key={entry.id}>
                  {formatDateTime(entry.changedAt)} — {entry.action === "reset" ? "vrátené pôvodné znenie" : "uložené nové znenie"}
                  {entry.changedByName === null ? "" : ` (${entry.changedByName})`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
