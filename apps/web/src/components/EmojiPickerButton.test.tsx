import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EmojiPickerButton, insertEmojiAtSelection } from "./EmojiPickerButton.js";

// issue 440: emoji picker — čistá vkladacia logika + komponent (prepínač +
// popover). Ukladanie/render emoji funguje (overené integračne inde) — tu ide
// o samotné vloženie na pozíciu kurzora.

afterEach(cleanup);

describe("insertEmojiAtSelection (čistá logika)", () => {
  it("vloží emoji na pozíciu kurzora (prázdny výber uprostred)", () => {
    expect(insertEmojiAtSelection("ahoj", 2, 2, "🙂")).toEqual({ value: "ah🙂oj", cursor: 4 });
  });
  it("prepíše výber", () => {
    expect(insertEmojiAtSelection("ahoj", 1, 3, "👍")).toEqual({ value: "a👍j", cursor: 3 });
  });
  it("vloží do prázdneho poľa", () => {
    expect(insertEmojiAtSelection("", 0, 0, "✅")).toEqual({ value: "✅", cursor: 1 });
  });
  it("oreže pozície mimo rozsahu na koniec poľa", () => {
    expect(insertEmojiAtSelection("abc", 99, 99, "🔥")).toEqual({ value: "abc🔥", cursor: 5 });
  });
});

// Kontrolovaný obal, ktorý zrkadlí reálne použitie (Poznámky/Upozornenia).
function Harness(): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("test ");
  return (
    <>
      <textarea ref={ref} value={value} onChange={(e) => { setValue(e.target.value); }} data-testid="ta" />
      <EmojiPickerButton targetRef={ref} value={value} onChange={setValue} testId="emoji" />
    </>
  );
}

describe("EmojiPickerButton (komponent)", () => {
  it("prepínač otvorí/zavrie popover", () => {
    render(<Harness />);
    expect(screen.queryByTestId("emoji-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("emoji"));
    expect(screen.getByTestId("emoji-popover")).toBeDefined();
    fireEvent.click(screen.getByTestId("emoji"));
    expect(screen.queryByTestId("emoji-popover")).toBeNull();
  });

  it("klik na emoji ho vloží na pozíciu kurzora cieľového poľa", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("emoji"));
    const ta = screen.getByTestId<HTMLTextAreaElement>("ta");
    ta.focus();
    ta.setSelectionRange(5, 5); // za "test "
    fireEvent.click(screen.getByRole("button", { name: "Vložiť 👍" }));
    expect(ta.value).toBe("test 👍");
    // Po vložení sa popover ZAVRIE (inak by prekryl tlačidlo Uložiť pod poľom).
    expect(screen.queryByTestId("emoji-popover")).toBeNull();
  });

  it("klik mimo pickeru popover zavrie", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("emoji"));
    expect(screen.getByTestId("emoji-popover")).toBeDefined();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("emoji-popover")).toBeNull();
  });

  it("disabled prepínač sa nedá otvoriť", () => {
    function DisabledHarness(): JSX.Element {
      const ref = useRef<HTMLTextAreaElement>(null);
      return <EmojiPickerButton targetRef={ref} value="" onChange={() => {}} testId="emoji" disabled />;
    }
    render(<DisabledHarness />);
    const toggle = screen.getByTestId<HTMLButtonElement>("emoji");
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("emoji-popover")).toBeNull();
  });
});
