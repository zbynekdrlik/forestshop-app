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

// issue 455: emoji picker nesmie stratiť text napísaný PRED emoji, ani keď React
// controlled `value` prop ZAOSTÁVA za živým DOM-om. Na CI runneri emoji klik
// bežal skôr, než React skomitoval `onChange` z predošlého `.fill()`, takže
// stará prázdna prop hodnota prepísala napísaný text na holé "✅"
// (`insertEmojiAtSelection("", …)` s caret-om orezaným na dĺžku 0). Insert musí
// bázovú hodnotu čítať zo ŽIVÉHO DOM-u poľa (`el.value`), z toho istého
// elementu ako výber — nie zo snímky propu.
describe("EmojiPickerButton — vloženie použije živú DOM hodnotu, nie zaostávajúci prop (issue 455)", () => {
  it("nestratí napísaný text, keď `value` prop zaostáva za DOM-om", () => {
    const received: string[] = [];
    function StaleHarness(): JSX.Element {
      const ref = useRef<HTMLTextAreaElement>(null);
      // `value` prop zámerne ZAOSTÁVA (prázdny) za tým, čo je v DOM-e — presne
      // race stav z CI, keď React ešte neskomitoval onChange z `.fill()`.
      return (
        <>
          <textarea ref={ref} defaultValue="" data-testid="ta" />
          <EmojiPickerButton
            targetRef={ref}
            value=""
            onChange={(next) => {
              received.push(next);
            }}
            testId="emoji"
          />
        </>
      );
    }
    render(<StaleHarness />);
    const ta = screen.getByTestId<HTMLTextAreaElement>("ta");
    // DOM je PRED propom: používateľ napísal text (fill), React ešte neskomitol.
    ta.value = "Skontrolovať sklad ";
    ta.focus();
    ta.setSelectionRange(19, 19); // caret za textom, ako po `.fill()`
    fireEvent.click(screen.getByTestId("emoji"));
    fireEvent.click(screen.getByRole("button", { name: "Vložiť ✅" }));
    expect(received).toEqual(["Skontrolovať sklad ✅"]);
  });
});
