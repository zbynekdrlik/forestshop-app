import { useCallback, useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchMailTemplates, MailTemplatesUnauthorizedError, type MailTemplate } from "../mailTemplatesApi.js";
import { MailTemplateEditor } from "./MailTemplateEditor.js";

// issue 192, majiteľ: "pri každej veci čo posiela mail by mala byť možnosť
// zmeniť text mailu". Vľavo zoznam druhov e-mailov, vpravo úprava vybraného.
//
// Rovnaké dve role, aké server vyžaduje na uloženie
// (`requireRole("admin", "manazer")`) — čítať znenie smie každý prihlásený
// zamestnanec, rovnaká úroveň ako ostatné obrazovky.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function MailTemplatesSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [templates, setTemplates] = useState<readonly MailTemplate[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  const load = useCallback(() => {
    fetchMailTemplates()
      .then((list) => {
        setTemplates(list);
        setLoaded(true);
        setSelectedKey((current) => (current === "" ? (list[0]?.key ?? "") : current));
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof MailTemplatesUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Texty e-mailov sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (templates === null) return <p role="alert">Texty e-mailov sa nepodarilo načítať.</p>;

  const selected = templates.find((t) => t.key === selectedKey) ?? templates[0];

  return (
    <section>
      <p>
        Znenie každého e-mailu, ktorý appka posiela. Polia v zložených zátvorkách sa pri odoslaní nahradia skutočnými údajmi — meno zákazníka, číslo objednávky a
        podobne.
      </p>

      <div className="mt-layout">
        <nav className="mt-list" aria-label="Druhy e-mailov" data-testid="mail-template-list">
          {templates.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`mt-list-item${t.key === selected?.key ? " active" : ""}`}
              onClick={() => {
                setSelectedKey(t.key);
              }}
              data-testid={`mail-template-pick-${t.key}`}
            >
              <span className="mt-list-label">{t.label}</span>
              {t.isCustomized && <span className="pill">upravené</span>}
            </button>
          ))}
        </nav>

        {selected === undefined ? (
          <p>Žiadny druh e-mailu nie je nastavený.</p>
        ) : (
          // Prepnutie druhu namontuje editor NANOVO — rozpísané znenie sa tak
          // vždy načíta z aktuálnych props a nepotrebuje synchronizačný efekt.
          <MailTemplateEditor
            key={selected.key}
            template={selected}
            canEdit={CONTROL_ROLES.has(role)}
            onSaved={load}
            onSessionExpired={onSessionExpired}
          />
        )}
      </div>
    </section>
  );
}
