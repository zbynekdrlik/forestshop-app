import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// issue 471: „pick" režim — klik na emoji rovno zavolá `onPick(emoji)` (bez
// vkladania do poľa), voľba „bez emoji" zavolá `onPick(null)`. Ten istý zdieľaný
// popover + zoznam ako insert režim (Úlohy na dnes ho použijú na jednoklikové
// označenie celého riadku).
describe("EmojiPickerButton — pick režim (issue 471)", () => {
  it("klik na emoji zavolá onPick(emoji) a zavrie popover", () => {
    const picked: (string | null)[] = [];
    render(
      <EmojiPickerButton
        testId="pick"
        onPick={(e) => {
          picked.push(e);
        }}
        showClear
        label="Pridať/zmeniť emoji"
      />,
    );
    fireEvent.click(screen.getByTestId("pick"));
    expect(screen.getByTestId("pick-popover")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Vložiť 🚀" }));
    expect(picked).toEqual(["🚀"]);
    // Po výbere sa popover ZAVRIE — jeden klik = hotovo.
    expect(screen.queryByTestId("pick-popover")).toBeNull();
  });

  it("voľba „bez emoji" zavolá onPick(null) a zavrie popover", () => {
    const picked: (string | null)[] = [];
    render(
      <EmojiPickerButton
        testId="pick"
        onPick={(e) => {
          picked.push(e);
        }}
        showClear
      />,
    );
    fireEvent.click(screen.getByTestId("pick"));
    fireEvent.click(screen.getByTestId("pick-clear"));
    expect(picked).toEqual([null]);
    expect(screen.queryByTestId("pick-popover")).toBeNull();
  });

  it("prepínač nesie zadaný label (aria-label + title)", () => {
    render(<EmojiPickerButton testId="pick" onPick={() => {}} label="Pridať/zmeniť emoji" />);
    expect(screen.getByRole("button", { name: "Pridať/zmeniť emoji" })).toBeDefined();
  });

  it("bez showClear sa voľba „bez emoji" nezobrazí", () => {
    render(<EmojiPickerButton testId="pick" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId("pick"));
    expect(screen.queryByTestId("pick-clear")).toBeNull();
  });

  it("zdieľaný zoznam obsahuje rozšírené emoji Štěpánovej sady (issue 471)", () => {
    render(<EmojiPickerButton testId="pick" onPick={() => {}} />);
    fireEvent.click(screen.getByTestId("pick"));
    for (const e of ["👏", "🚀", "🥳", "📣", "🤯", "😭", "😆", "🤷", "😳", "😜", "🤨"]) {
      expect(screen.getByRole("button", { name: `Vložiť ${e}` })).toBeDefined();
    }
  });
});

// issue 455 (hlbšia príčina flaku upozornenia.spec.ts:271): obnova fokusu +
// caretu po vložení emoji beží v `requestAnimationFrame`. rAF vystrelí AŽ keď
// kompozítor vyrobí snímku — na zaťaženom (CI) stroji to môže zaostať o stovky
// ms, kľudne až do chvíle, keď používateľ (alebo Playwright `.fill()` DRUHÉHO
// poľa, čo je dvojkroková operácia focus→insertText) už fokusuje INÉ pole.
// Bezpodmienečná obnova fokusu vtedy UKRADNE fokus späť na pôvodné pole a text
// sa napíše do zlého poľa (v teste: „Skontrolovať sklad" skončí v nadpise,
// podrobnosti ostanú prázdne → emoji vyjde ako holé „✅"). rAF musí fokus vrátiť
// len keď je STÁLE „náš" (aktívny prvok je pole samo, náš popover/root, <body>
// alebo nič).
describe("EmojiPickerButton — oneskorený rAF neukradne fokus, keď sa medzičasom presunul inam (issue 455)", () => {
  it("nevráti fokus na svoje pole, keď je medzičasom fokusnuté iné pole", () => {
    const rafCbs: FrameRequestCallback[] = [];
    // Zachytíme rAF callbacky, aby sme ich vystrelili RUČNE až po presune fokusu
    // — deterministicky modeluje „rAF vystrelil neskoro, počas práce s iným poľom".
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback): number => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      function TwoFieldHarness(): JSX.Element {
        const refA = useRef<HTMLInputElement>(null);
        const [a, setA] = useState("Urgentné ");
        return (
          <>
            <input ref={refA} value={a} onChange={(e) => { setA(e.target.value); }} data-testid="pole-a" />
            <EmojiPickerButton targetRef={refA} value={a} onChange={setA} testId="emoji-a" />
            <input defaultValue="" data-testid="pole-b" />
          </>
        );
      }
      render(<TwoFieldHarness />);
      const poleA = screen.getByTestId<HTMLInputElement>("pole-a");
      const poleB = screen.getByTestId<HTMLInputElement>("pole-b");
      poleA.focus();
      poleA.setSelectionRange(9, 9); // za "Urgentné "
      fireEvent.click(screen.getByTestId("emoji-a"));
      fireEvent.click(screen.getByRole("button", { name: "Vložiť 🔥" })); // insert() naplánuje rAF (zachytený)
      // Používateľ / `.fill()` iného poľa medzičasom presunie fokus na pole B:
      poleB.focus();
      expect(document.activeElement).toBe(poleB);
      // Až TERAZ vystrelí oneskorený rAF z insertu poľa A:
      rafCbs.forEach((cb) => { cb(0); });
      // Fokus NESMIE byť ukradnutý späť na pole A:
      expect(document.activeElement).toBe(poleB);
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });
});
