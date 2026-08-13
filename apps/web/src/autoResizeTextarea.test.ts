import { expect, it } from "vitest";
import { autoResizeTextarea } from "./autoResizeTextarea.js";

// issue 410: jsdom vždy vráti `scrollHeight === 0` (žiadny reálny layout) —
// test preto MOCKUJE `scrollHeight` cez `Object.defineProperty` (rovnaký
// vzor, aký by potreboval hocijaký test nad hodnotou, ktorú jsdom nikdy
// nevypočíta samo). Skutočný rast je overený AŽ e2e testom
// (`floor-notes.spec.ts`), presne ako `.claude/rules/testing.md`'s
// "focus return after overlay close" bod (jsdom nevie simulovať reálny
// layout, taký test patrí do e2e).
function textareaWithScrollHeight(value: number): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  Object.defineProperty(el, "scrollHeight", { value, configurable: true });
  return el;
}

it("nastaví výšku podľa scrollHeight, keď je nenulový", () => {
  const el = textareaWithScrollHeight(120);
  autoResizeTextarea(el);
  expect(el.style.height).toBe("120px");
});

it("nikdy neprepíše výšku na '0px' (jsdom vždy vráti 0)", () => {
  const el = textareaWithScrollHeight(0);
  el.style.height = "50px";
  autoResizeTextarea(el);
  // `height: auto` je nastavené (aby ĎALŠIE meranie scrollHeight bolo
  // správne v reálnom prehliadači), ale KONEČNÁ hodnota sa neprepíše na
  // "0px" — funkcia jednoducho výšku ponechá tak, ako ju nastavil `auto`.
  expect(el.style.height).toBe("auto");
});
