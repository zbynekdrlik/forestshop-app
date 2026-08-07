import { describe, expect, it } from "vitest";
import { ORDER_STUCK_THRESHOLD_DAYS, daysStuck, isUnfinishedOrderStatus, stuckOrderUpozornenieDedupKey } from "./stuck-status.js";

// issue 301: tretie automatické Upozornenie — objednávka, ktorá dlho visí v
// NEVYBAVENOM stave. Naživo overené stavy (7. 8. 2026): "Vybavuje sa" (31
// objednávok), "Nevybavená" (3 objednávky) — presne tieto dva, žiadny ďalší.
describe("isUnfinishedOrderStatus", () => {
  it("rozpozná oba naživo overené nevybavené stavy", () => {
    expect(isUnfinishedOrderStatus("Vybavuje sa")).toBe(true);
    expect(isUnfinishedOrderStatus("Nevybavená")).toBe(true);
  });

  it("hotové/iné stavy vrátia false", () => {
    expect(isUnfinishedOrderStatus("Vybavená")).toBe(false);
    expect(isUnfinishedOrderStatus("Kompletná")).toBe(false);
    expect(isUnfinishedOrderStatus("Zabalená")).toBe(false);
    expect(isUnfinishedOrderStatus("Stornovaná")).toBe(false);
    expect(isUnfinishedOrderStatus("")).toBe(false);
  });

  it("normalizuje (NFC + orez) rovnako ako `order.status_name`, nikdy bajtovo presnú zhodu", () => {
    expect(isUnfinishedOrderStatus("  Vybavuje sa  ")).toBe(true);
    expect(isUnfinishedOrderStatus("Nevybavená".normalize("NFD"))).toBe(true);
  });
});

describe("daysStuck", () => {
  it("počíta celé dni medzi placedAt a now", () => {
    expect(daysStuck(new Date("2026-04-30T10:00:00Z"), new Date("2026-08-07T10:00:00Z"))).toBe(99);
  });

  it("nikdy nevráti záporné číslo (budúci placedAt sa berie ako 0)", () => {
    expect(daysStuck(new Date("2026-08-10T10:00:00Z"), new Date("2026-08-07T10:00:00Z"))).toBe(0);
  });
});

describe("ORDER_STUCK_THRESHOLD_DAYS", () => {
  it("je pomenovaná konštanta, nie natvrdo napísané číslo na mieste použitia", () => {
    expect(ORDER_STUCK_THRESHOLD_DAYS).toBe(14);
  });
});

describe("stuckOrderUpozornenieDedupKey", () => {
  it("je stabilný na objednávku, vo VLASTNOM menom priestore (nekoliduje s posta:/posta-vratena:/vratenie:)", () => {
    expect(stuckOrderUpozornenieDedupKey("20260805")).toBe("objednavka-visi:20260805");
  });
});
