import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OrderReminderEmailedRow } from "./OrderReminderRow.js";
import type { OrderReminderResolvedRow } from "../orderReminderApi.js";

// issue 293: dátum vyriešenia sa predtým robil odseknutím prvých desiatich
// znakov z UTC ISO reťazca (`row.resolvedAt.slice(0, 10)`) — nečitateľný
// tvar ("2026-08-05") a pre časy medzi 22:00 a polnocou SLOVENSKÉHO času
// ukázal o deň SKORŠÍ dátum, než je náš kalendárny deň.

const ROW: OrderReminderResolvedRow = {
  orderCode: "20260900",
  adminLink: "https://admin.example/order/1",
  name: "Test Zákazník",
  phone: "",
  email: "zakaznik@example.com",
  itemLabel: "",
  days: 3,
  // 2026-08-05T22:10:00Z = 2026-08-06 00:10 Europe/Bratislava (letný čas) —
  // presne minútu po slovenskej polnoci, ešte v UTC deň PREDTÝM.
  resolvedAt: "2026-08-05T22:10:00.000Z",
  resolvedBy: "ai",
};

afterEach(() => {
  cleanup();
});

it("issue 293: dátum vyriešenia tesne po SLOVENSKEJ polnoci sa zobrazí ako DNEŠNÝ slovenský deň v čitateľnom tvare, nie včerajší UTC rez", () => {
  render(
    <table>
      <tbody>
        <OrderReminderEmailedRow row={ROW} />
      </tbody>
    </table>,
  );
  const cell = screen.getByRole("row").lastElementChild;
  expect(cell?.textContent).toBe("6. 8. 2026");
});
