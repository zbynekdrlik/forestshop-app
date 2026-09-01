// issue 519: čistá (bez DB, bez siete) logika hlasovej poznámky — samostatne
// testovateľná. Web nahrá krátku poznámku (MediaRecorder), server ju uloží na
// riadok `daily_task` a (ak je k dispozícii OpenAI kľúč) prepíše cez Whisper.

// Zástupný text, keď prepis chýba alebo zlyhá — audio-only poznámka. `hasAudio`
// odlišuje audio-only riadok, `text` ostáva NOT NULL (rozhodnutie v dizajne:
// žiadny dvoj/troj-stĺpcový CHECK, `.claude/rules/database.md`).
export const VOICE_NOTE_PLACEHOLDER = "🎤 Hlasová poznámka";

// Vlastný strop prepisu — NIE manuálny `max(300)` z písaného vstupu. Diktovaná
// poznámka počas šoférovania môže byť dlhšia; radšej ju orežeme, než by ju zod
// ticho odmietol a stratil dobrý prepis (audio ostáva aj tak).
export const VOICE_TRANSCRIPT_MAX_CHARS = 2000;

// Strop veľkosti nahrávky (vynútený PRED bufferovaním v trase) a spodná hranica
// (0-bajtová „nahrávka" z omylom spusteného MediaRecordera → 400, nie insert).
export const VOICE_MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const VOICE_MIN_AUDIO_BYTES = 1024;

// Povolené MIME → prípona súboru pre OpenAI multipart. OpenAI háda formát z
// PRÍPONY názvu súboru (nie z content-type), takže názov musí mať správnu
// príponu, inak vráti 400 „Invalid file format". `;codecs=…` sa odstrihne.
// `null` = nepodporované MIME → trasa odmietne (400) skôr, než sa čokoľvek uloží.
const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** Základné MIME bez `;codecs=…` parametra (`audio/webm;codecs=opus` → `audio/webm`). */
export function baseMime(mime: string): string {
  const semi = mime.indexOf(";");
  return (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
}

/** Prípona súboru pre dané MIME (bez bodky), alebo `null` pre nepodporované. */
export function audioExtensionForMime(mime: string): string | null {
  return MIME_TO_EXTENSION[baseMime(mime)] ?? null;
}

/**
 * Text úlohy z prepisu: `null`/prázdny/whitespace (= zlyhaný alebo prázdny
 * prepis) → zástupný text; inak orezaný a (ak treba) skrátený na strop s „…".
 * Whisper na sk/cs halucinuje na tichu, preto prázdny prepis = zlyhanie.
 */
export function voiceTaskText(transcript: string | null): string {
  if (transcript === null) return VOICE_NOTE_PLACEHOLDER;
  const trimmed = transcript.trim();
  if (trimmed === "") return VOICE_NOTE_PLACEHOLDER;
  if (trimmed.length <= VOICE_TRANSCRIPT_MAX_CHARS) return trimmed;
  let cut = trimmed.slice(0, VOICE_TRANSCRIPT_MAX_CHARS - 1);
  // Nerež uprostred surrogate páru (emoji) — osamelý high-surrogate by sa do
  // Postgresu zapísal ako U+FFFD (�). Odstráň visiaci high-surrogate na konci.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
