import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PostaUncollectedRow } from "./PostaUncollectedRow.js";
import type { PostaUncollectedShipment } from "../postaUncollectedApi.js";

// issue 293: `retainedTill` (termín vyzdvihnutia) aj `lastSentAt` (naposledy
// poslané) sa vykresľovali ako SUROVÝ tvar "YYYY-MM-DD" priamo zo servera
// namiesto slovenského "12. 8. 2026" — nečitateľné pre bežného používateľa.

const SHIPMENT: PostaUncollectedShipment = {
  orderCode: "20260900",
  packageNumber: "EF123456789SK",
  name: "Test Zákazník",
  email: "",
  phone: "",
  officeName: "Pošta 1",
  officeAddr: "",
  retainedTill: "2026-08-12",
  notifiedSince: "2026-08-06",
  daysAtPost: 2,
  count: 1,
  lastSentAt: "2026-08-06",
  callNeeded: false,
  trackingLink: "https://tracking.example/EF123456789SK",
  adminLink: "https://admin.example/order/1",
};

afterEach(() => {
  cleanup();
});

it("issue 293: termín vyzdvihnutia a dátum posledného odoslania sa zobrazia v slovenskom tvare, nie ako surový YYYY-MM-DD zo servera", () => {
  render(
    <table>
      <tbody>
        <PostaUncollectedRow shipment={SHIPMENT} onPreview={vi.fn()} />
      </tbody>
    </table>,
  );
  const row = screen.getByTestId(`posta-row-${SHIPMENT.packageNumber}`);
  expect(row.textContent).toContain("12. 8. 2026");
  expect(row.textContent).not.toContain("2026-08-12");
  expect(row.textContent).toContain("6. 8. 2026");
  expect(row.textContent).not.toContain("2026-08-06");
});
