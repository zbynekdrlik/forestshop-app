import { log } from "../../logger.js";
import { trackingApiUrl } from "./constants.js";

/** Vstrekované rozhranie (rovnaký zámer ako `MailTransport`/`OrdersExportFetcher`
 * — testy dodávajú falošný klient, NIKDY nekontaktujú skutočné api.posta.sk,
 * per ticketu). Vrátené `unknown` je buď surový JSON tela odpovede, alebo
 * doslovne `null` — `null` = zlyhanie (timeout, sieť, ne-2xx, nevalidný
 * JSON), volajúci (`run.ts`) to zaznamená ako per-shipment chybu, nikdy
 * nespadne. (`unknown` už `null` v sebe zahŕňa — návratový typ je zámerne
 * len `Promise<unknown>`, nie `Promise<unknown | null>`.) */
export type TrackingClient = (packageNumber: string) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 15_000;

export function createHttpTrackingClient(options: { readonly timeoutMs?: number } = {}): TrackingClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (packageNumber: string): Promise<unknown> => {
    try {
      const response = await fetch(trackingApiUrl(packageNumber), { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        log.warn({ packageNumber, status: response.status }, "sledovanie zásielky (posta.sk) vrátilo ne-2xx");
        return null;
      }
      return await response.json();
    } catch (error) {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.warn({ packageNumber, rawErrorMessage }, "sledovanie zásielky (posta.sk) zlyhalo");
      return null;
    }
  };
}
