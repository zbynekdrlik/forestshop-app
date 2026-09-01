import { describe, expect, it } from "vitest";
import { audioExtensionForMime, baseMime, VOICE_NOTE_PLACEHOLDER, VOICE_TRANSCRIPT_MAX_CHARS, voiceTaskText } from "./voice.js";

describe("baseMime", () => {
  it("odstrihne ;codecs=… a znormalizuje na malé písmená", () => {
    expect(baseMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(baseMime("AUDIO/MP4")).toBe("audio/mp4");
    expect(baseMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
  });
});

describe("audioExtensionForMime", () => {
  it("mapuje podporované MIME na správnu príponu (Whisper háda formát z názvu súboru)", () => {
    expect(audioExtensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtensionForMime("audio/mp4")).toBe("m4a");
    expect(audioExtensionForMime("audio/ogg")).toBe("ogg");
    expect(audioExtensionForMime("audio/mpeg")).toBe("mp3");
    expect(audioExtensionForMime("audio/wav")).toBe("wav");
  });
  it("vráti null pre nepodporované MIME", () => {
    expect(audioExtensionForMime("audio/aiff")).toBeNull();
    expect(audioExtensionForMime("video/mp4")).toBeNull();
    expect(audioExtensionForMime("")).toBeNull();
  });
});

describe("voiceTaskText", () => {
  it("null alebo prázdny/whitespace prepis → zástupný text", () => {
    expect(voiceTaskText(null)).toBe(VOICE_NOTE_PLACEHOLDER);
    expect(voiceTaskText("")).toBe(VOICE_NOTE_PLACEHOLDER);
    expect(voiceTaskText("   \n ")).toBe(VOICE_NOTE_PLACEHOLDER);
  });
  it("oreže whitespace okolo prepisu", () => {
    expect(voiceTaskText("  Zavolať Novákovi ohľadom sáčkov  ")).toBe("Zavolať Novákovi ohľadom sáčkov");
  });
  it("skráti priveľmi dlhý prepis na strop s výpustkou (audio ostáva zachované)", () => {
    const long = "a".repeat(VOICE_TRANSCRIPT_MAX_CHARS + 50);
    const out = voiceTaskText(long);
    expect(out.length).toBe(VOICE_TRANSCRIPT_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
  it("presne stropovo dlhý prepis sa nemení", () => {
    const exact = "b".repeat(VOICE_TRANSCRIPT_MAX_CHARS);
    expect(voiceTaskText(exact)).toBe(exact);
  });
  it("nereže uprostred emoji (surrogate páru) — žiadny U+FFFD", () => {
    // Emoji začína presne na rezovej hranici (index MAX-2), takže naivný slice by
    // odrezal jeho high-surrogate a Postgres by dostal U+FFFD (�).
    const head = "a".repeat(VOICE_TRANSCRIPT_MAX_CHARS - 2);
    const out = voiceTaskText(`${head}😀${"b".repeat(50)}`);
    expect(out.includes("�")).toBe(false);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe(`${head}…`);
  });
});
