import { describe, expect, it } from "vitest";
import { hasOurBlock, mergeShopRemark, NOTE_BLOCK_END, NOTE_BLOCK_START } from "./note-block.js";

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
});
