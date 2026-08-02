import { log } from "../../logger.js";
import { buildClassifierMessages, parseClassification } from "./logic.js";

/** Vstrekované rozhranie (rovnaký zámer ako `MailTransport`/`TrackingClient`
 * — testy dodávajú falošný klient, NIKDY nekontaktujú skutočné OpenAI, per
 * ticketu). `true` = zákazník už kontaktovaný (e-mail sa neposiela), `false`
 * = nekontaktovaný (posiela sa pripomienka). Vyhodí na zlyhanie (sieť,
 * ne-2xx, nerozpoznaná kategória) — volajúci (`run.ts`) to zaznamená ako
 * per-objednávkovú chybu, nikdy nespadne celý beh. */
export type ClassifyClient = (shopRemark: string | null) => Promise<boolean>;

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TIMEOUT_MS = 60_000;
const OPENAI_MODEL = "gpt-4o-mini";

export function createOpenAiClassifyClient(options: { readonly apiKey: string; readonly timeoutMs?: number }): ClassifyClient {
  const { apiKey } = options;
  const timeoutMs = options.timeoutMs ?? OPENAI_TIMEOUT_MS;
  return async (shopRemark: string | null): Promise<boolean> => {
    const messages = buildClassifierMessages(shopRemark);
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Authorization header (nikdy URL) — API kľúč sa tak nikdy neobjaví
        // v žiadnej chybovej hláške/logu odvodenom z URL.
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      log.warn({ status: response.status, bodyText }, "OpenAI klasifikácia (Pripomienky objednávok) vrátila ne-2xx");
      throw new Error(`OpenAI vrátilo ${String(response.status)}`);
    }
    const json = (await response.json()) as { readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAI odpoveď nemá očakávaný tvar (chýba choices[0].message.content)");
    }
    return parseClassification(content);
  };
}
