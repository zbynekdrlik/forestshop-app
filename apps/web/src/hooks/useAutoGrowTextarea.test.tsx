import { act, cleanup, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea.js";

// issue 593: JS fallback cesty (prehliadač BEZ CSS `field-sizing: content` —
// Firefox, Štěpánov prehliadač). `CSS.supports` sa stubuje EXPLICITNE (nie
// spoliehať na to, čo jsdom vráti), jsdom nemá layout, preto sa `scrollHeight`
// mockuje podľa počtu riadkov
// (20px/riadok + 4px padding, aspoň `rows` riadkov ako reálny prehliadač pri
// `height: auto`). Reálny rast v Chromiu aj Firefoxe dokazuje e2e
// (`tests/e2e/writingField.ts`).

let pxPerLine = 20;
// Zachytené `ResizeObserver` callbacky — jsdom ResizeObserver nemá, test ho
// stubuje a zmenu šírky poľa (zbalenie/rozbalenie bočného panela) vyvolá ručne.
let observers: { cb: ResizeObserverCallback; el: Element | null }[] = [];

function resizeTo(width: number): void {
  for (const o of observers) {
    if (o.el === null) continue;
    const entry = { target: o.el, contentRect: { width } } as unknown as ResizeObserverEntry;
    o.cb([entry], {} as ResizeObserver);
  }
}

beforeEach(() => {
  pxPerLine = 20;
  observers = [];
  vi.stubGlobal("CSS", { supports: () => false });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly rec: { cb: ResizeObserverCallback; el: Element | null };
      constructor(cb: ResizeObserverCallback) {
        this.rec = { cb, el: null };
        observers.push(this.rec);
      }
      observe(el: Element): void {
        this.rec.el = el;
      }
      disconnect(): void {
        this.rec.el = null;
      }
    },
  );
  // rAF synchrónne — prepočet po zmene šírky ide cez rAF (inak by zmena výšky
  // v RO callbacku vyvolala „ResizeObserver loop" chybu v konzole).
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      const lines = Math.max(this.value.split("\n").length, this.rows);
      return lines * pxPerLine + 4;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
});

function Field({ value, active = true, itemKey = "a" }: { readonly value: string; readonly active?: boolean; readonly itemKey?: string }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrowTextarea(ref, value, active, itemKey);
  // `key` = iná poznámka v úprave → NOVÝ <textarea> element (ako v zozname).
  return <textarea key={itemKey} ref={ref} rows={3} value={value} readOnly data-testid="pole" />;
}

const sixLines = "1\n2\n3\n4\n5\n6";

it("pri pripojení s dlhým textom (otvorenie úpravy) má hneď výšku podľa obsahu", () => {
  const { getByTestId } = render(<Field value={sixLines} />);
  expect(getByTestId("pole").style.height).toBe("124px");
});

it("rastie pri zmene hodnoty a po vyprázdnení (uložení) sa vráti na 3 riadky", () => {
  const { getByTestId, rerender } = render(<Field value="jeden" />);
  expect(getByTestId("pole").style.height).toBe("64px");
  rerender(<Field value={sixLines} />);
  expect(getByTestId("pole").style.height).toBe("124px");
  // Prázdne pole: inline výška sa ZRUŠÍ (výšku dá `rows={3}` + CSS
  // `min-height`), nemeria sa `scrollHeight` — Chromium/WebKit doň rátajú aj
  // zalomený PLACEHOLDER (na 375px by prázdne pole malo 5 riadkov).
  rerender(<Field value="" />);
  expect(getByTestId("pole").style.height).toBe("");
});

it("po zmene šírky POĽA (okno aj zbalenie bočného panela — iné zalomenie) prepočíta výšku", () => {
  const { getByTestId } = render(<Field value={sixLines} />);
  act(() => {
    resizeTo(300);
  });
  pxPerLine = 30;
  act(() => {
    resizeTo(200);
  });
  expect(getByTestId("pole").style.height).toBe("184px");
});

it("prepnutie úpravy na INÚ poznámku s rovnakým textom (nový element) má hneď výšku podľa obsahu", () => {
  const { getByTestId, rerender } = render(<Field value={sixLines} itemKey="a" />);
  rerender(<Field value={sixLines} itemKey="b" />);
  expect(getByTestId("pole").style.height).toBe("124px");
});

it("ručne roztiahnuté pole (úchyt) sa po vyprázdnení vráti na 3 riadky aj pri `field-sizing`", () => {
  vi.stubGlobal("CSS", { supports: (prop: string, val: string) => prop === "field-sizing" && val === "content" });
  const { getByTestId, rerender } = render(<Field value={sixLines} />);
  getByTestId("pole").style.height = "300px"; // prehliadač po ťahaní úchytom
  rerender(<Field value="" />);
  expect(getByTestId("pole").style.height).toBe("");
});

it("neaktívne pole (úprava zatvorená) nemení výšku", () => {
  const { getByTestId } = render(<Field value={sixLines} active={false} />);
  expect(getByTestId("pole").style.height).toBe("");
});

it("prehliadač s `field-sizing: content` rastie sám — hook nenastaví inline výšku", () => {
  vi.stubGlobal("CSS", { supports: (prop: string, val: string) => prop === "field-sizing" && val === "content" });
  const { getByTestId } = render(<Field value={sixLines} />);
  expect(getByTestId("pole").style.height).toBe("");
});
