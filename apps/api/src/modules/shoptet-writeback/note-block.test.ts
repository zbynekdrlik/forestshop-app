import { describe, expect, it } from "vitest";
import { extractForeignShopRemark, hasOurBlock, mergeShopRemark, NOTE_BLOCK_END, NOTE_BLOCK_START } from "./note-block.js";

describe("mergeShopRemark", () => {
  it("appends our block to an empty field", () => {
    const result = mergeShopRemark(null, "Zavolať zajtra");
    expect(result).toBe(`${NOTE_BLOCK_START}\nZavolať zajtra\n${NOTE_BLOCK_END}`);
  });

  it("appends our block after existing manual text, separated by a blank line", () => {
    const result = mergeShopRemark("Ručná poznámka predajne", "Zavolať zajtra");
    expect(result).toBe(`Ručná poznámka predajne\n\n${NOTE_BLOCK_START}\nZavolať zajtra\n${NOTE_BLOCK_END}`);
  });

  it("replaces ONLY our block's content on a second sync, never touching manual text", () => {
    const afterFirst = mergeShopRemark("Ručná poznámka predajne", "Zavolať zajtra");
    const afterSecond = mergeShopRemark(afterFirst, "Nová poznámka");
    expect(afterSecond).toBe(`Ručná poznámka predajne\n\n${NOTE_BLOCK_START}\nNová poznámka\n${NOTE_BLOCK_END}`);
  });

  it("is idempotent — merging the SAME note again changes nothing (no blank-line accumulation)", () => {
    const afterFirst = mergeShopRemark("Ručná poznámka predajne", "Zavolať zajtra");
    const afterSecond = mergeShopRemark(afterFirst, "Zavolať zajtra");
    expect(afterSecond).toBe(afterFirst);
  });

  it("removes ONLY our block (and its separator) when our note is cleared, preserving manual text exactly", () => {
    const withBlock = mergeShopRemark("Ručná poznámka predajne", "Zavolať zajtra");
    const cleared = mergeShopRemark(withBlock, null);
    expect(cleared).toBe("Ručná poznámka predajne");
  });

  it("clears to an empty string when the field had ONLY our block", () => {
    const withBlock = mergeShopRemark(null, "Zavolať zajtra");
    const cleared = mergeShopRemark(withBlock, "");
    expect(cleared).toBe("");
  });

  it("treats a whitespace-only note the same as clearing", () => {
    const withBlock = mergeShopRemark("Ručná poznámka", "Zavolať zajtra");
    const cleared = mergeShopRemark(withBlock, "   \n  ");
    expect(cleared).toBe("Ručná poznámka");
  });

  it("never touches manual text when our note stays empty and no block exists yet", () => {
    expect(mergeShopRemark("Len ručný text, žiadny blok appky", null)).toBe("Len ručný text, žiadny blok appky");
  });

  it("hasOurBlock detects presence/absence correctly", () => {
    expect(hasOurBlock("Len ručný text")).toBe(false);
    expect(hasOurBlock(mergeShopRemark(null, "x"))).toBe(true);
    expect(hasOurBlock(mergeShopRemark("Ručný text", "x"))).toBe(true);
  });

  // issue 169: OUR_BLOCK_RE bez /g flagu odstráni pri clear-e (ourNote=null)
  // len PRVÝ výskyt nášho bloku — druhý by unikol do "cudzej" časti.
  it("removes BOTH occurrences of our block when the field somehow has two, not just the first", () => {
    const raw =
      `Ručná poznámka\n\n` +
      `${NOTE_BLOCK_START}\nStará poznámka\n${NOTE_BLOCK_END}` +
      `\n\n` +
      `${NOTE_BLOCK_START}\nDuplicitná poznámka\n${NOTE_BLOCK_END}`;
    const cleared = mergeShopRemark(raw, null);
    expect(cleared).toBe("Ručná poznámka");
  });

  // issue 169: voliteľný oddeľovací prefix zachytával len `\n{1,2}`, nie
  // `\r\n` — CRLF-oddelený blok by po odstránení nechal osamotený prázdny
  // riadok (CR) za sebou.
  it("removes the block AND its CRLF-style separator, not just LF", () => {
    const raw = `Ručná poznámka\r\n\r\n${NOTE_BLOCK_START}\r\nZavolať\r\n${NOTE_BLOCK_END}`;
    const cleared = mergeShopRemark(raw, null);
    expect(cleared).toBe("Ručná poznámka");
  });
});

// issue 164: čítacia strana (import) — z RAW importovanej hodnoty vytiahne
// LEN cudziu (nie-appkinu) časť, nikdy náš vlastný blok.
describe("extractForeignShopRemark", () => {
  it("vráti null, keď Shoptet nič nemá vyplnené", () => {
    expect(extractForeignShopRemark(null)).toBeNull();
  });

  it("vráti celý text, keď v poli nie je náš blok (100% dnešných reálnych dát)", () => {
    expect(extractForeignShopRemark("Zákazník je stavebná firma, vybaviť prednostne")).toBe(
      "Zákazník je stavebná firma, vybaviť prednostne",
    );
  });

  it("odstráni LEN náš blok, cudzí text pred aj za ním ostáva nedotknutý", () => {
    const raw = mergeShopRemark("Ručná poznámka predajne PRED", "Naša poznámka") + "\n\nRučná poznámka ZA";
    expect(extractForeignShopRemark(raw)).toBe("Ručná poznámka predajne PRED\n\nRučná poznámka ZA");
  });

  it("vráti null, keď v poli je LEN náš blok (žiadny cudzí text)", () => {
    const raw = mergeShopRemark(null, "Naša poznámka");
    expect(extractForeignShopRemark(raw)).toBeNull();
  });

  // issue 169: DVA naše bloky v raw hodnote (napr. starý bug/ručná
  // duplikácia priamo v Shoptete) — druhý sa nesmie zobraziť ako cudzí text.
  it("odstráni OBA naše bloky, druhý nikdy neunikne ako cudzí text", () => {
    const raw =
      `Foreign PRED\n\n` +
      `${NOTE_BLOCK_START}\nStará\n${NOTE_BLOCK_END}` +
      `\n\n` +
      `${NOTE_BLOCK_START}\nDuplicitná\n${NOTE_BLOCK_END}` +
      `\n\nForeign ZA`;
    expect(extractForeignShopRemark(raw)).toBe("Foreign PRED\n\nForeign ZA");
  });
});
