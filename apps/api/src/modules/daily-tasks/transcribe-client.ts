import { log } from "../../logger.js";
import { audioExtensionForMime, baseMime } from "./voice.js";

// issue 519: prepis hlasovej poznámky cez OpenAI Whisper. Vstrekované rozhranie
// (rovnaký zámer ako `ClassifyClient` z Pripomienok objednávok) — testy dodajú
// falošný klient, NIKDY nekontaktujú skutočné OpenAI. Vracia SUROVÝ prepis (môže
// byť prázdny); volajúci (`daily-tasks-routes.ts`) rozhodne o zástupnom texte.
// VYHODÍ na zlyhanie (bez kľúča sa klient vôbec nevytvorí; sieť/ne-2xx/timeout) —
// volajúci to zachytí a uloží audio-only poznámku, nikdy nestratí nahrávku.
export interface TranscribeInput {
  readonly audio: Buffer;
  readonly mime: string;
}
export type TranscribeClient = (input: TranscribeInput) => Promise<string>;

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TIMEOUT_MS = 20_000;
const OPENAI_MODEL = "whisper-1";

export function createOpenAiTranscribeClient(options: { readonly apiKey: string; readonly timeoutMs?: number }): TranscribeClient {
  const { apiKey } = options;
  const timeoutMs = options.timeoutMs ?? OPENAI_TIMEOUT_MS;
  return async ({ audio, mime }: TranscribeInput): Promise<string> => {
    // Prípona MUSÍ zodpovedať formátu — OpenAI háda formát z názvu súboru, nie
    // z content-type. Nepodporované MIME sem nemá prísť (trasa ho odmietne
    // skôr), poistka `webm` len keby predsa.
    const ext = audioExtensionForMime(mime) ?? "webm";
    const form = new FormData();
    form.append("file", new Blob([audio], { type: baseMime(mime) }), `voice.${ext}`);
    form.append("model", OPENAI_MODEL);
    // Slovenský diktát — jazyk zlepšuje presnosť a znižuje halucinácie.
    form.append("language", "sk");
    // `text` = telo odpovede je priamo prepis (žiadne JSON obaľovanie).
    form.append("response_format", "text");
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      // Authorization header (nikdy URL) — kľúč sa tak neobjaví v žiadnej
      // chybovej hláške/logu odvodenom z URL (rovnaký vzor ako klasifikátor).
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      log.warn({ status: response.status, bodyText }, "OpenAI prepis (Hlasová poznámka) vrátil ne-2xx");
      throw new Error(`OpenAI vrátilo ${String(response.status)}`);
    }
    return await response.text();
  };
}
