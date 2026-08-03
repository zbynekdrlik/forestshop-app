import { describe, expect, it } from "vitest";
import { MAIL_TEMPLATE_KINDS } from "../mail-templates/registry.js";
import {
  buildClassifierMessages,
  buildReminderEmail,
  daysOpen,
  fingerprint,
  isEligibleOrder,
  isOldEnough,
  parseClassification,
} from "./logic.js";

describe("isEligibleOrder", () => {
  it("objednávka v nastavenom otvorenom stave je eligible", () => {
    expect(isEligibleOrder({ statusName: "Vybavuje sa" }, new Set(["Vybavuje sa"]))).toBe(true);
  });

  it("objednávka mimo nastaveného zoznamu (napr. Vybavená/Stornovaná) nie je eligible", () => {
    expect(isEligibleOrder({ statusName: "Vybavená" }, new Set(["Vybavuje sa"]))).toBe(false);
    expect(isEligibleOrder({ statusName: "Stornovaná" }, new Set(["Vybavuje sa"]))).toBe(false);
  });
});

describe("daysOpen / isOldEnough", () => {
  const now = new Date("2026-08-02T00:00:00Z");

  it("presne 4 dni staré je 'staršie ako 4 dni' (>=)", () => {
    const placedAt = new Date("2026-07-29T00:00:00Z");
    expect(daysOpen(placedAt, now)).toBe(4);
    expect(isOldEnough(placedAt, now)).toBe(true);
  });

  it("3 dni staré ešte NIE JE eligible na spracovanie", () => {
    const placedAt = new Date("2026-07-30T00:00:00Z");
    expect(daysOpen(placedAt, now)).toBe(3);
    expect(isOldEnough(placedAt, now)).toBe(false);
  });

  it("budúci dátum sa berie ako 0 dní, nikdy záporne", () => {
    const placedAt = new Date("2026-08-10T00:00:00Z");
    expect(daysOpen(placedAt, now)).toBe(0);
  });
});

describe("fingerprint", () => {
  it("rovnaký dátum + poznámka → rovnaký odtlačok", () => {
    const a = { placedAt: new Date("2026-07-01T10:00:00Z"), shopRemark: "volať zákazníka" };
    const b = { placedAt: new Date("2026-07-01T10:00:00Z"), shopRemark: "volať zákazníka" };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("zmenená poznámka → iný odtlačok", () => {
    const a = { placedAt: new Date("2026-07-01T10:00:00Z"), shopRemark: "volať zákazníka" };
    const b = { placedAt: new Date("2026-07-01T10:00:00Z"), shopRemark: "volané, počká" };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("null poznámka sa berie ako prázdny reťazec, nie ako 'null' text", () => {
    const a = { placedAt: new Date("2026-07-01T10:00:00Z"), shopRemark: null };
    expect(fingerprint(a)).toBe("2026-07-01T10:00:00.000Z|");
  });
});

describe("buildReminderEmail", () => {
  it("obsahuje meno aj kód objednávky, HTML-escapované", () => {
    const built = buildReminderEmail(MAIL_TEMPLATE_KINDS["order_reminder"].defaultText, 'Ján "Test" <Novák>', "20260001");
    expect(built.subject).toBe("📦 Stav vašej objednávky z Forestshop.sk");
    expect(built.html).toContain("&lt;Novák&gt;");
    expect(built.html).toContain("&quot;Test&quot;");
    expect(built.html).toContain("20260001");
    expect(built.text).toContain("20260001");
  });
});

describe("buildClassifierMessages / parseClassification", () => {
  it("prázdna poznámka sa pošle ako BEZ POZNAMKY", () => {
    const messages = buildClassifierMessages(null);
    expect(messages[1]?.content).toContain("BEZ POZNAMKY");
  });

  it("skutočná poznámka sa pošle doslovne", () => {
    const messages = buildClassifierMessages("volané so zákazníkom, počká");
    expect(messages[1]?.content).toContain("volané so zákazníkom, počká");
  });

  it("parsuje čistý JSON objekt kontaktovany → true", () => {
    expect(parseClassification('{"kategoria": "kontaktovany"}')).toBe(true);
  });

  it("parsuje čistý JSON objekt nekontaktovany → false", () => {
    expect(parseClassification('{"kategoria": "nekontaktovany"}')).toBe(false);
  });

  it("tolerantné voči ```json plotu", () => {
    expect(parseClassification('```json\n{"kategoria": "kontaktovany"}\n```')).toBe(true);
  });

  it("tolerantné voči holému reťazcu kategórie", () => {
    expect(parseClassification('"nekontaktovany"')).toBe(false);
  });

  it("nerozpoznaná odpoveď vyhodí, nikdy nehádaj", () => {
    expect(() => parseClassification("neviem")).toThrow(/nevrátil platnú kategóriu/);
  });
});
