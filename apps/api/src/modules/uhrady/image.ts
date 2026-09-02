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
