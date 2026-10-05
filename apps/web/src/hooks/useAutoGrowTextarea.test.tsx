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

beforeEach(() => {
  pxPerLine = 20;
  vi.stubGlobal("CSS", { supports: () => false });
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

function Field({ value, active = true }: { readonly value: string; readonly active?: boolean }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrowTextarea(ref, value, active);
  return <textarea ref={ref} rows={3} value={value} readOnly data-testid="pole" />;
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
  rerender(<Field value="" />);
  expect(getByTestId("pole").style.height).toBe("64px");
});

it("po zmene šírky okna (iné zalomenie) prepočíta výšku", () => {
  const { getByTestId } = render(<Field value={sixLines} />);
  pxPerLine = 30;
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(getByTestId("pole").style.height).toBe("184px");
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
