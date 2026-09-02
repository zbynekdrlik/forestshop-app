// issue 543: čistá (bez DB, bez siete) logika obrázkového skenu — samostatne
// testovateľná (rovnaký vzor ako `daily-tasks/voice.ts`).

// Strop veľkosti jedného skenu (vynútený PRED bufferovaním v trase) a spodná
// hranica (prázdny/omylom nahraný súbor → 400, nie insert). 15 MB pokryje aj
// veľký fotený sken FA z telefónu; grid načíta len viditeľné cez `loading=lazy`.
export const SCAN_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const SCAN_MIN_IMAGE_BYTES = 64;

// Popis pod thumbnailom — rozumný strop, aby sa pole nezneužilo na dlhý text.
export const SCAN_DESCRIPTION_MAX_CHARS = 500;

// Povolené MIME obrázkov (zadanie: jpg/png). Nepodporované → trasa odmietne
// (400) skôr, než sa čokoľvek uloží. `null` = nepovolené.
const ALLOWED_IMAGE_MIME: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);

/** Základné MIME bez prípadného `;parametra` a v malých písmenách. */
export function baseImageMime(mime: string): string {
  const semi = mime.indexOf(";");
  return (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
}

/** `true`, ak je MIME povolený obrázkový formát (jpg/png). */
export function isAllowedImageMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIME.has(baseImageMime(mime));
}

// Kontrola magických bajtov (signatúra súboru) — MIME je od klienta, takže sa
// naň nespoliehame ako na jediný dôkaz formátu. Bránime "HTML/skript nahraný ako
// image/png" (defense-in-depth popri `nosniff` + image Content-Type). Buffer už
// aj tak celý máme v pamäti, takže je to lacné.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** `true`, ak bajty začínajú platnou PNG alebo JPEG signatúrou. */
export function looksLikeJpegOrPng(bytes: Buffer): boolean {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return true;
  if (bytes.length >= JPEG_SIGNATURE.length && bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return true;
  return false;
}
