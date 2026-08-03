import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";

// issue 191: náhľad e-mailu pred odoslaním sa už nerozbaľuje na spodku
// stránky (majiteľ: "rozbaluje sa na spodku to je zle") — otvorí sa ako
// dialóg cez obrazovku, takže je okamžite v zornom poli a nedá sa prehliadnuť.
// Zámerne NIE natívny `<dialog>`/`showModal()`: jsdom ho neimplementuje, takže
// by sa dal overiť len e2e testom a existujúce vitest testy tejto obrazovky by
// prestali vidieť obsah. Vlastný prekryv je plne testovateľný v oboch vrstvách.
//
// Komponenta je generická (žiadna zmienka o "nedostupných tovaroch") — ďalšie
// automatizácie posielajú e-maily rovnakým spôsobom a majú ten istý kontrakt
// "bez potvrdenia človekom e-mail neodíde".
export function MailPreviewDialog({
  testId,
  title,
  recipient,
  subject,
  html,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  onClose,
  returnFocusRef,
  children,
}: {
  readonly testId: string;
  readonly title: string;
  readonly recipient: string;
  readonly subject: string;
  readonly html: string;
  readonly confirmLabel: string;
  readonly confirmDisabled: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly children?: ReactNode;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Esc zavrie dialóg. Poslucháč je na `document`, nie na paneli — inak by
  // fungoval len kým je fokus vnútri, a ten sa dá kliknutím stratiť.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Fokus do dialógu pri otvorení a späť na pôvodný prvok pri zavretí — bez
  // toho by čítačka obrazovky aj klávesnica ostali v zozname za prekryvom.
  //
  // `document.activeElement` v momente OTVORENIA na to nestačí: náhľad sa
  // načítava zo servera a spúšťacie tlačidlo je počas načítania `disabled` —
  // prehliadač z neho fokus zhodí na `<body>`, takže dialóg by mal čo vracať
  // až príliš neskoro (overené naživo na produkcii, issue 191). Volajúci preto
  // môže odovzdať `returnFocusRef` so spúšťacím prvkom zapamätaným pri kliknutí.
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const target = returnFocusRef?.current ?? previous;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [returnFocusRef]);

  // Pozadie sa pod otvoreným dialógom neposúva — inak by koliesko myši
  // skrolovalo zoznam za ním namiesto obsahu náhľadu.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      data-testid={`${testId}-backdrop`}
      onClick={(e) => {
        // Len klik na samotný prekryv, nikdy klik, ktorý vybublal z obsahu
        // dialógu — inak by sa zatváral pri každom kliknutí dnu.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        tabIndex={-1}
        ref={panelRef}
      >
        <h3 id={`${testId}-title`} className="modal-title">
          {title}
        </h3>
        <p className="modal-meta">
          Komu: {recipient} — Predmet: {subject}
        </p>
        {/* `html` je appkou GENEROVANÝ e-mail (napr. `buildEmailForType`,
            `modules/nedostupne/logic.ts`) — meno zákazníka aj náhradné
            produkty sú tam už HTML-escapované, nikdy surový užívateľský
            vstup priamo tu. */}
        <div className="modal-body" dangerouslySetInnerHTML={{ __html: html }} />
        {children}
        <div className="modal-actions">
          <button
            type="button"
            className="btn lg good"
            disabled={confirmDisabled}
            onClick={onConfirm}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </button>
          <button type="button" className="btn lg ghost" onClick={onClose} data-testid={`${testId}-cancel`}>
            Zrušiť
          </button>
        </div>
      </div>
    </div>
  );
}
