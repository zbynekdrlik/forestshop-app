import type { JSX } from "react";
import type { OrderReminderPendingRow, OrderReminderResolvedRow, OrderReminderRow } from "../orderReminderApi.js";

// Vydelené z `OrderReminderSection.tsx` (issue 173) — rovnaký vzor ako
// `PostaUncollectedRow.tsx`/`OrderLineRow.tsx` (`.claude/rules/
// frontend-design.md`): opakovaná per-riadková JSX jednotka sa vyčleňuje
// ako prvá, keď súbor rastie.

function AdminLinkCell({ row }: { readonly row: OrderReminderRow }): JSX.Element {
  return (
    <td>
      <a href={row.adminLink} target="_blank" rel="noreferrer">
        {row.orderCode}
      </a>
    </td>
  );
}

/** 🔴 "bez poznámky" — dve ručné tlačidlá (ticket): "▶ Poslať pripomienku"
 * (pošle hneď, aj keď by automatika nemala) a "✓ Kontaktované" (označí ako
 * vybavené ručne, bez e-mailu). */
export function OrderReminderNoteRow({
  row,
  busy,
  onSend,
  onContact,
}: {
  readonly row: OrderReminderRow;
  readonly busy: boolean;
  readonly onSend: (orderCode: string) => void;
  readonly onContact: (orderCode: string) => void;
}): JSX.Element {
  return (
    <tr data-testid={`order-reminder-red-${row.orderCode}`}>
      <AdminLinkCell row={row} />
      <td>{row.name}</td>
      <td>{row.phone !== "" ? row.phone : "—"}</td>
      <td>{row.email !== "" ? row.email : "—"}</td>
      <td>{row.itemLabel !== "" ? row.itemLabel : "—"}</td>
      <td>{row.days}</td>
      <td>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          data-testid={`order-reminder-send-${row.orderCode}`}
          onClick={() => {
            onSend(row.orderCode);
          }}
        >
          ▶ Poslať pripomienku
        </button>{" "}
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy}
          data-testid={`order-reminder-contact-${row.orderCode}`}
          onClick={() => {
            onContact(row.orderCode);
          }}
        >
          ✓ Kontaktované
        </button>
      </td>
    </tr>
  );
}

/** ✉️ "bez e-mailovej adresy" — bez akcií, treba doplniť adresu v Shoptete. */
export function OrderReminderNoEmailRow({ row }: { readonly row: OrderReminderRow }): JSX.Element {
  return (
    <tr data-testid={`order-reminder-noemail-${row.orderCode}`}>
      <AdminLinkCell row={row} />
      <td>{row.name}</td>
      <td>{row.phone !== "" ? row.phone : "—"}</td>
      <td>{row.itemLabel !== "" ? row.itemLabel : "—"}</td>
      <td>{row.days}</td>
    </tr>
  );
}

/** 🟠 "pripomienka už odoslaná" — uzavreté, bez akcie. */
export function OrderReminderEmailedRow({ row }: { readonly row: OrderReminderResolvedRow }): JSX.Element {
  return (
    <tr data-testid={`order-reminder-emailed-${row.orderCode}`}>
      <AdminLinkCell row={row} />
      <td>{row.name}</td>
      <td>{row.email}</td>
      <td>{row.itemLabel !== "" ? row.itemLabel : "—"}</td>
      <td>{row.resolvedAt.slice(0, 10)}</td>
    </tr>
  );
}

interface SkippedRowProps {
  readonly row: OrderReminderResolvedRow | OrderReminderPendingRow;
  readonly icon: string;
  readonly reason: string;
  readonly busy: boolean;
  readonly onPreview: (orderCode: string) => void;
  readonly onSend: (orderCode: string) => void;
}

/** ⚪/✋/⚠️ "preskočené" — AI usúdila kontaktovaný / vybavil ručne človek /
 * automatika začala ale nedokončila. Každý riadok má náhľad + možnosť
 * poslať ho ručne (override, presne ako ticket žiada). */
export function OrderReminderSkippedRow({ row, icon, reason, busy, onPreview, onSend }: SkippedRowProps): JSX.Element {
  return (
    <tr data-testid={`order-reminder-skipped-${row.orderCode}`}>
      <AdminLinkCell row={row} />
      <td>{row.name}</td>
      <td>
        {icon} {reason}
      </td>
      <td>{row.days}</td>
      <td>
        <button
          type="button"
          className="btn sm ghost"
          data-testid={`order-reminder-preview-${row.orderCode}`}
          onClick={() => {
            onPreview(row.orderCode);
          }}
        >
          👁 Náhľad
        </button>{" "}
        <button
          type="button"
          className="btn sm"
          disabled={busy || row.email === ""}
          data-testid={`order-reminder-skipped-send-${row.orderCode}`}
          onClick={() => {
            onSend(row.orderCode);
          }}
        >
          ▶ Poslať ručne
        </button>
      </td>
    </tr>
  );
}
