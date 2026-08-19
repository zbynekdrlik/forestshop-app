import { describe, expect, it } from "vitest";
import { buildAutomationStatus, STATIC_AUTOMATION_STATUS } from "./automationStatus.js";

// issue 447 — pilulka „Beží"/„Zastavené" musí byť pri VŠETKÝCH automatizáciách,
// nielen posta/order-reminder. Togglované automatizácie odrážajú `enabled`,
// always-on joby (supplier-stock/sync) sú staticky „on".

describe("buildAutomationStatus (issue 447)", () => {
  it("always-on joby (supplier-stock, sync) sú vždy 'on'", () => {
    expect(STATIC_AUTOMATION_STATUS["supplier-stock"]).toBe("on");
    expect(STATIC_AUTOMATION_STATUS["sync"]).toBe("on");
  });

  it("togglované automatizácie odrážajú enabled flag (restock doplnený, issue 447)", () => {
    const s = buildAutomationStatus({ postaUncollected: true, orderReminder: false, restock: true });
    expect(s["posta-uncollected"]).toBe("on");
    expect(s["order-reminder"]).toBe("off");
    expect(s["restock"]).toBe("on");
  });

  it("vypnutý restock ukáže 'off' (Zastavené), zapnutý 'on' (Beží)", () => {
    expect(buildAutomationStatus({ postaUncollected: false, orderReminder: false, restock: false })["restock"]).toBe("off");
    expect(buildAutomationStatus({ postaUncollected: false, orderReminder: false, restock: true })["restock"]).toBe("on");
  });

  it("always-on joby ostávajú 'on' bez ohľadu na togglované vstupy", () => {
    const s = buildAutomationStatus({ postaUncollected: false, orderReminder: false, restock: false });
    expect(s["supplier-stock"]).toBe("on");
    expect(s["sync"]).toBe("on");
  });

  it("mapuje presne 5 automatizácií (2 statické + 3 togglované)", () => {
    const s = buildAutomationStatus({ postaUncollected: true, orderReminder: true, restock: true });
    expect(Object.keys(s).sort()).toEqual(["order-reminder", "posta-uncollected", "restock", "supplier-stock", "sync"]);
  });
});
