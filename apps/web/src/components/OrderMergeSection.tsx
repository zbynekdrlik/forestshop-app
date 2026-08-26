import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Me } from "../api.js";
import {
  fetchOrderMergeCandidates,
  fetchOrderMergePreview,
  OrderMergeUnauthorizedError,
  sendOrderMergeMail,
  type MergeCandidateGroup,
  type OrderMergeList,
  type OrderMergePreview,
} from "../orderMergeApi.js";
import { MailPreviewDialog } from "./MailPreviewDialog.js";

// issue 257: "Zlúčenie objednávok" — vlastná záložka v Eshope (majiteľova
// korekcia: "malo by to byt zalozka v eshope a mali by tam vyskocit ak su
// dve objedanvky na toho isteho zakaznika"). Rovnaká rolová úroveň ako
// "Nedostupné tovary": čítanie vidí každý prihlásený, odoslanie len
// admin/manazer.
const CONTROL_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

interface PendingSend {
  readonly group: MergeCandidateGroup;
  readonly preview: OrderMergePreview;
}

function groupKey(group: MergeCandidateGroup): string {
  return group.orders.map((o) => o.orderId).join(",");
}

export function OrderMergeSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [list, setList] = useState<OrderMergeList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<PendingSend | null>(null);
  // issue 277: obsluhou upravený text okna náhľadu — rovnaký vzor ako
  // `NedostupneSection.tsx`.
  const [editedBody, setEditedBody] = useState("");
  // issue 191's vzor (`NedostupneSection.tsx`) — spúšťacie tlačidlo sa počas
  // načítania náhľadu stáva `disabled`, prehliadač z neho fokus zhodí.
  const triggerRef = useRef<HTMLElement | null>(null);
  const canControl = CONTROL_ROLES.has(role);

  const load = useCallback(() => {
    fetchOrderMergeCandidates()
      .then((l) => {
        setList(l);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof OrderMergeUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Zoznam kandidátov na zlúčenie sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  const openPreview = useCallback(
    (group: MergeCandidateGroup) => {
      const [base, ...rest] = group.orders;
      if (base === undefined) return;
      const key = groupKey(group);
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setActionError("");
      setBusyKey(key);
      fetchOrderMergePreview(
        base.orderId,
        rest.map((o) => o.orderId),
      )
        .then((preview) => {
          setPending({ group, preview });
          setEditedBody(preview.text);
        })
        .catch((err: unknown) => {
          if (err instanceof OrderMergeUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Náhľad sa nepodarilo načítať.");
        })
        .finally(() => {
          setBusyKey("");
        });
    },
    [onSessionExpired],
  );

  const confirmSend = useCallback(() => {
    if (pending === null) return;
    const [base, ...rest] = pending.group.orders;
    if (base === undefined) return;
    const key = groupKey(pending.group);
    setBusyKey(key);
    sendOrderMergeMail(
      base.orderId,
      rest.map((o) => o.orderId),
      pending.preview.previewToken,
      editedBody,
    )
      .then((result) => {
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setPending(null);
        load();
      })
      .catch((err: unknown) => {
        if (err instanceof OrderMergeUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setActionError(err instanceof Error ? err.message : "Odoslanie zlyhalo.");
      })
      .finally(() => {
        setBusyKey("");
      });
  }, [pending, editedBody, load, onSessionExpired]);

  if (!loaded) return <p>Načítavam…</p>;
  if (error !== "") return <p role="alert">{error}</p>;
  if (list === null) return <p role="alert">Zoznam kandidátov na zlúčenie sa nepodarilo načítať.</p>;

  return (
    <section>
      <p>Zákazníci, ktorí majú viac ako jednu otvorenú objednávku — dá sa im poslať e-mail, že ich objednávky posielame spolu ako jednu zásielku.</p>

      {list.bccMissing && (
        <p role="alert" data-testid="order-merge-bcc-missing">
          ⚠️ Chýba adresa pre skrytú kópiu majiteľovi (ORDER_MERGE_BCC_EMAIL) — automatizácia zatiaľ NEPOŠLE žiadny e-mail zákazníkovi.
        </p>
      )}
      {list.mailNotConfigured && (
        <p role="alert" data-testid="order-merge-mail-not-configured">
          ⚠️ Odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST).
        </p>
      )}
      {actionError !== "" && <p role="alert">{actionError}</p>}

      {list.groups.length === 0 ? (
        <p data-testid="order-merge-empty">Momentálne žiadny zákazník nemá viac ako jednu otvorenú objednávku.</p>
      ) : (
        <div className="order-merge-groups" data-testid="order-merge-groups">
          {list.groups.map((group) => {
            const key = groupKey(group);
            const busy = busyKey === key;
            // Testid podľa VIDITEĽNÉHO Shoptet čísla objednávky (nie
            // interného DB `orderId`, UUID) — rovnaký zámer ako
            // `NedostupneSection.tsx`'s `variantCode`-kľúčované testid,
            // stabilné a čitateľné aj v e2e teste napísanom vopred.
            const testKey = group.orders[0]?.externalOrderId ?? key;
            return (
              <div className="card" key={key} data-testid={`order-merge-group-${testKey}`}>
                <div className="order-merge-group-header">
                  <span className="order-merge-customer">{group.customerName}</span>
                  <span>{group.email === null || group.email === "" ? "(bez e-mailu)" : group.email}</span>
                </div>
                <ul className="order-merge-orders">
                  {group.orders.map((o) => (
                    // issue 512: číslo objednávky je klikateľné — priamy odkaz
                    // do Shoptet administrácie (rovnaký `.ord-admin-link` vzor
                    // ako „Na objednanie"/„Riešiť"/„Vyhľadať").
                    <li key={o.orderId}>
                      č.{" "}
                      <a
                        href={o.adminUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ord-admin-link"
                        aria-label={`Otvoriť objednávku ${o.externalOrderId} v administrácii Shoptet`}
                        title="Otvoriť v administrácii Shoptet"
                      >
                        {o.externalOrderId}
                      </a>
                    </li>
                  ))}
                </ul>
                {canControl && (
                  <button
                    type="button"
                    className="btn lg ghost"
                    disabled={busy}
                    onClick={() => {
                      openPreview(group);
                    }}
                    data-testid={`order-merge-send-${testKey}`}
                  >
                    ✉️ Poslať e-mail o zlúčení — náhľad
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pending !== null && (
        <MailPreviewDialog
          testId="order-merge-preview"
          title="Náhľad e-mailu — povinné pred odoslaním"
          recipient={pending.preview.recipient}
          subject={pending.preview.subject}
          bodyText={editedBody}
          onBodyTextChange={setEditedBody}
          confirmLabel="📧 Odoslať zákazníkovi"
          confirmDisabled={busyKey !== "" || editedBody.trim() === ""}
          onConfirm={confirmSend}
          returnFocusRef={triggerRef}
          onClose={() => {
            setPending(null);
          }}
        />
      )}
    </section>
  );
}
