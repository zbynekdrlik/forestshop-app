import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderWriteFailuresBanner } from "./OrderWriteFailuresBanner.js";
import type { OrderWriteFailure } from "../ordersWriteFailures.js";

afterEach(cleanup);

it("bez zlyhaní nevykreslí NIČ (žiadny prázdny alert)", () => {
  const { container } = render(<OrderWriteFailuresBanner failures={[]} onDismiss={() => {}} />);
  expect(container.innerHTML).toBe("");
});

it("s JEDNÝM zlyhaním ukáže nadpis v jednotnom čísle a jeho popis", () => {
  const zlyhania: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001, kód A-1", detail: "Riadok objednávky sa nenašiel" },
  ];
  render(<OrderWriteFailuresBanner failures={zlyhania} onDismiss={() => {}} />);
  expect(screen.getByRole("alert").textContent).toBe(
    "⚠️ Nepodarilo sa uložiť 1 položku×Zmena stavu — obj. 1001, kód A-1 (Riadok objednávky sa nenašiel)",
  );
});

it("s VIACERÝMI NEZÁVISLÝMI zlyhaniami ukáže VŠETKY naraz, kumulatívne (jadro ticketu #66)", () => {
  const zlyhania: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001, kód A-1", detail: "chyba A" },
    { id: "ordered:2", what: "Príznak objednané", where: "obj. 1002, kód B-1", detail: "chyba B" },
  ];
  render(<OrderWriteFailuresBanner failures={zlyhania} onDismiss={() => {}} />);
  expect(screen.getByTestId("order-write-failures").textContent).toContain("Nepodarilo sa uložiť 2 položky");
  expect(screen.getByTestId("order-write-failure-state:1").textContent).toBe(
    "Zmena stavu — obj. 1001, kód A-1 (chyba A)",
  );
  expect(screen.getByTestId("order-write-failure-ordered:2").textContent).toBe(
    "Príznak objednané — obj. 1002, kód B-1 (chyba B)",
  );
});

it("kliknutie na '×' zavolá onDismiss (zavrie CELÝ banner naraz)", () => {
  const onDismiss = vi.fn();
  const zlyhania: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "chyba" },
  ];
  render(<OrderWriteFailuresBanner failures={zlyhania} onDismiss={onDismiss} />);
  fireEvent.click(screen.getByRole("button", { name: "Zavrieť hlásenie o neuložených zmenách" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("položka bez `where` (riadok medzitým zmizol zo zoznamu) vynechá pomlčku, nenechá vetu 'ohnutú'", () => {
  const zlyhania: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "", detail: "chyba" },
  ];
  render(<OrderWriteFailuresBanner failures={zlyhania} onDismiss={() => {}} />);
  expect(screen.getByTestId("order-write-failure-state:1").textContent).toBe("Zmena stavu (chyba)");
});
