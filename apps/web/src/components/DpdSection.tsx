import { useCallback, useContext, useEffect, useMemo, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { DpdBadgeRefreshContext } from "../dpdBadgeContext.js";
import {
  DpdUnauthorizedError,
  fetchDpdPreview,
  fetchDpdShippableOrders,
  requestDpdPickup,
  sendDpdShipments,
  type DpdShipmentPreview,
  type DpdShipmentResult,
  type DpdShippableOrder,
} from "../dpdApi.js";
import { formatSkDateTime } from "../formatDate.js";

// issue 445: slovenské množné číslo pre feedback text pri hornom tlačidle
// ("Objednané: N zásielok"/"N úspešných, M chýb") — šéf ho číta na telefóne,
// takže "1 zásielok" by znelo zle.
function pluralZasielka(n: number): string {
  if (n === 1) return `${String(n)} zásielka`;
  if (n >= 2 && n <= 4) return `${String(n)} zásielky`;
  return `${String(n)} zásielok`;
}

function pluralChyba(n: number): string {
  if (n === 1) return `${String(n)} chyba`;
  if (n >= 2 && n <= 4) return `${String(n)} chyby`;
  return `${String(n)} chýb`;
}

function pluralUspesna(n: number): string {
  if (n === 1) return `${String(n)} úspešná`;
  if (n >= 2 && n <= 4) return `${String(n)} úspešné`;
  return `${String(n)} úspešných`;
}

// issue 292: "Eshop → Preprava DPD" — 1) zoznam objednávok bez appka-vlastnej
// odoslanej zásielky, 2) klik na "Objednať prepravu DPD" ukáže PRESNÝ náhľad
// (nič sa ešte neposlalo), 3) až potvrdenie v náhľade skutočne spustí robota
// (per objednávka, jedno zlyhanie neblokuje ostatné), 4) samostatné
// "Objednať zvoz na deň". Adresa/hmotnosť/dobierka sa NIKDY nedohadujú —
// appka ich číta priamo z uloženej objednávky (`modules/dpd/preview.ts`).
const CAN_SEND_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

function orderKey(order: DpdShippableOrder): string {
  return order.preview.orderId;
}

function todayIso(): string {
  // Europe/Bratislava, nie UTC — rovnaký dôvod ako `formatDate.ts` (appka
  // beží na serveri, ktorého systémové pásmo nemusí byť slovenské).
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

export function DpdSection({ role, onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [configured, setConfigured] = useState(false);
  const [orders, setOrders] = useState<readonly DpdShippableOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const canSend = CAN_SEND_ROLES.has(role);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [weightDrafts, setWeightDrafts] = useState<Readonly<Record<string, string>>>({});

  const [previewItems, setPreviewItems] = useState<readonly DpdShipmentPreview[] | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResults, setSendResults] = useState<readonly DpdShipmentResult[] | null>(null);

  const [pickupDate, setPickupDate] = useState(todayIso());
  const [pickupBusy, setPickupBusy] = useState(false);
  const [pickupMessage, setPickupMessage] = useState("");

  // issue 445: po úspešnom odoslaní bumpne nav odznak "Objednať DPD" v
  // App.tsx, aby počet HNEĎ klesol (zoznam sa zmenšil) — rovnaký vzor ako
  // `UpozorneniaSection`'s `UpozorneniaBadgeRefreshContext`.
  const { refresh: refreshDpdBadge } = useContext(DpdBadgeRefreshContext);

  // issue 445: viditeľný súhrn pri HORNOM tlačidle (bez skrolovania) — "N
  // zásielok" pri úplnom úspechu, "N úspešných, M chýb" pri čiastočnom.
  const sendNotice = useMemo(() => {
    if (sendResults === null) return "";
    const ok = sendResults.filter((r) => r.ok).length;
    const fail = sendResults.length - ok;
    if (fail === 0) return `Objednané: ${pluralZasielka(ok)}`;
    return `${pluralUspesna(ok)}, ${pluralChyba(fail)}`;
  }, [sendResults]);

  const load = useCallback(() => {
    fetchDpdShippableOrders()
      .then((result) => {
        setConfigured(result.configured);
        setOrders(result.orders);
        setLoaded(true);
        setLoadError("");
        setSelected((prev) => {
          const stillPresent = new Set(result.orders.map(orderKey));
          return new Set([...prev].filter((id) => stillPresent.has(id)));
        });
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof DpdUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setLoadError("Zoznam objednávok na odoslanie sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function weightFor(order: DpdShippableOrder): string {
    return weightDrafts[orderKey(order)] ?? order.preview.weightKg;
  }

  // issue 292 review finding: posielať CELÝ `weightDrafts` (aj koncepty pre
  // objednávky MIMO tejto požiadavky) by mohlo poslať rozpísanú/neplatnú
  // hodnotu iného riadku (napr. "1." počas písania) a serverova validácia
  // (`z.record` so spoločným regexom) by tým 400-kla CELÚ požiadavku, aj
  // keď sa vybraných objednávok vôbec netýka. Odošli len prekryv s
  // aktuálne posielanými `orderIds`.
  function weightOverridesFor(orderIds: readonly string[]): Readonly<Record<string, string>> {
    const ids = new Set(orderIds);
    return Object.fromEntries(Object.entries(weightDrafts).filter(([id]) => ids.has(id)));
  }

  function openPreview(): void {
    const orderIds = [...selected];
    if (orderIds.length === 0) return;
    setPreviewError("");
    setSendResults(null);
    setPreviewBusy(true);
    fetchDpdPreview(orderIds, weightOverridesFor(orderIds))
      .then((items) => {
        setPreviewItems(items);
      })
      .catch((err: unknown) => {
        if (err instanceof DpdUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setPreviewError(err instanceof Error ? err.message : "Náhľad sa nepodarilo vypočítať.");
      })
      .finally(() => {
        setPreviewBusy(false);
      });
  }

  function closePreview(): void {
    setPreviewItems(null);
    setPreviewError("");
  }

  function confirmSend(): void {
    if (previewItems === null) return;
    const orderIds = previewItems.map((p) => p.orderId);
    setSendBusy(true);
    sendDpdShipments(orderIds, weightOverridesFor(orderIds))
      .then((results) => {
        setSendResults(results);
        setPreviewItems(null);
        setSelected(new Set());
        load();
        // issue 445: zoznam sa práve zmenšil o odoslané objednávky — daj
        // App.tsx vedieť, aby nav odznak "Objednať DPD" hneď klesol.
        refreshDpdBadge();
      })
      .catch((err: unknown) => {
        if (err instanceof DpdUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setPreviewError(err instanceof Error ? err.message : "Odoslanie zásielok zlyhalo.");
      })
      .finally(() => {
        setSendBusy(false);
      });
  }

  function submitPickup(): void {
    setPickupBusy(true);
    setPickupMessage("");
    requestDpdPickup(pickupDate)
      .then((result) => {
        setPickupMessage(result.ok ? "Zvoz objednaný." : (result.error ?? "Objednanie zvozu zlyhalo."));
      })
      .catch((err: unknown) => {
        if (err instanceof DpdUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setPickupMessage(err instanceof Error ? err.message : "Objednanie zvozu zlyhalo.");
      })
      .finally(() => {
        setPickupBusy(false);
      });
  }

  return (
    <section data-testid="dpd-section">
      {!configured && loaded && (
        <p role="alert" data-testid="dpd-not-configured">
          DPD preprava nie je nakonfigurovaná (chýba prihlásenie do dpdshipper.sk).
        </p>
      )}
      {loadError !== "" && <p role="alert">{loadError}</p>}

      {/* issue 451: denná preprava (zvoz) je PRIMÁRNA akcia záložky —
          najprominentnejšie tlačidlo (btn good lg), prvá v poradí, nad
          per-zásielkovým objednaním aj tabuľkou. Text rešpektuje Štěpánov
          krok 7 (objednávka sa hneď odošle DPD a už sa nedá upraviť). */}
      <div data-testid="dpd-pickup">
        <p>Objednanie dennej prepravy (zvozu DPD). Vyber deň a klikni — objednávka sa hneď odošle DPD a už sa nedá upraviť.</p>
        <label htmlFor="dpd-pickup-date">Objednať zvoz na deň</label>
        <input
          id="dpd-pickup-date"
          type="date"
          value={pickupDate}
          onChange={(e) => {
            setPickupDate(e.target.value);
          }}
        />
        <button type="button" className="btn good lg" disabled={!configured || !canSend || pickupBusy} onClick={submitPickup} data-testid="dpd-pickup-submit">
          🚚 Objednať zvoz na deň
        </button>
        {pickupMessage !== "" && (
          <p role="status" data-testid="dpd-pickup-message">
            {pickupMessage}
          </p>
        )}
      </div>

      {/* issue 451: per-zásielkové objednanie je SEKUNDÁRNE (pod primárnym
          zvozom) — jeho úvodný text sa presunul sem k nemu. */}
      {orders.length > 0 && (
        <p>
          Nižšie sú objednávky, ktoré appka ešte cez DPD neodoslala (a Shoptet pre ne nemá vlastné číslo zásielky).
          Označ pripravené objednávky a klikni „Objednať prepravu DPD“ — appka najprv ukáže presný náhľad,
          nič sa neodošle bez potvrdenia.
        </p>
      )}

      {/* issue 445: tlačidlo „Objednať prepravu DPD" + viditeľný feedback sú
          HORE (nad tabuľkou, k tlačidlu zvozu) — šéf ich predtým na konci
          dlhej tabuľky nenašiel. Feedback ostane viditeľný, aj keď sa zoznam
          po odoslaní vyprázdni (guard `sendNotice`, nie `orders.length`). */}
      {canSend && (orders.length > 0 || sendNotice !== "") && (
        <div data-testid="dpd-send-actions">
          {sendNotice !== "" && (
            <p role="status" data-testid="dpd-send-notice">
              {sendNotice}
            </p>
          )}
          {orders.length > 0 && (
            <button
              type="button"
              className="btn good"
              disabled={!configured || selected.size === 0 || previewBusy}
              onClick={openPreview}
              data-testid="dpd-open-preview"
            >
              📦 Objednať prepravu DPD ({selected.size})
            </button>
          )}
        </div>
      )}

      {loaded && orders.length === 0 && <p data-testid="dpd-empty">Žiadna objednávka nečaká na odoslanie.</p>}

      {orders.length > 0 && (
        <>
          <div className="fs-table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Objednávka</th>
                  <th>Dátum</th>
                  <th>Príjemca</th>
                  <th>Adresa</th>
                  <th>Hmotnosť (kg)</th>
                  <th>Dobierka</th>
                  <th>Posledné zlyhanie</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const id = orderKey(order);
                  const p = order.preview;
                  return (
                    <tr key={id} data-testid={`dpd-order-row-${p.externalOrderId}`}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Vybrať objednávku ${p.externalOrderId}`}
                          checked={selected.has(id)}
                          onChange={() => {
                            toggleSelected(id);
                          }}
                          disabled={!canSend || !p.addressComplete}
                        />
                      </td>
                      <td>{p.externalOrderId}</td>
                      <td>{formatSkDateTime(order.placedAt)}</td>
                      <td>{p.recipientName}</td>
                      <td>
                        {p.addressComplete ? (
                          <span>
                            {p.street} {p.houseNumber}, {p.city} {p.zip}, {p.countryName}
                          </span>
                        ) : (
                          <span data-testid={`dpd-address-incomplete-${p.externalOrderId}`}>Chýba adresa</span>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          aria-label={`Hmotnosť objednávky ${p.externalOrderId}`}
                          value={weightFor(order)}
                          disabled={!canSend}
                          onChange={(e) => {
                            setWeightDrafts((prev) => ({ ...prev, [id]: e.target.value }));
                          }}
                        />
                      </td>
                      <td>{p.isCod ? `${p.codAmount ?? "0"} €` : "—"}</td>
                      <td>{order.lastFailure ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* issue 445: detailný per-objednávkový výsledok ostáva (súhrn hore je
          `role=status`); tu je len prístupné meno zoznamu, aby čítačka
          obrazovky vedela, čo zoznam predstavuje. */}
      {sendResults !== null && (
        <ul aria-label="Výsledky odoslania — jednotlivé objednávky" data-testid="dpd-send-results">
          {sendResults.map((r) => (
            <li key={r.orderId} data-testid={`dpd-result-${r.orderId}`}>
              {r.ok ? `Odoslané, číslo zásielky ${r.parcelNumber ?? ""}` : `Zlyhalo: ${r.error ?? ""}`}
            </li>
          ))}
        </ul>
      )}

      {previewItems !== null && (
        <div role="dialog" aria-label="Náhľad DPD zásielok" data-testid="dpd-preview-dialog">
          <h3>Náhľad — nič sa ešte neodoslalo</h3>
          {previewError !== "" && <p role="alert">{previewError}</p>}
          <ul>
            {previewItems.map((p) => (
              <li key={p.orderId} data-testid={`dpd-preview-item-${p.externalOrderId}`}>
                {p.externalOrderId}: {p.recipientName}, {p.street} {p.houseNumber}, {p.city} {p.zip}, {p.countryName} — {p.weightKg} kg
                {p.isCod ? `, dobierka ${p.codAmount ?? "0"} €` : ""}
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm ghost" onClick={closePreview} disabled={sendBusy} data-testid="dpd-preview-cancel">
            Zrušiť
          </button>
          <button type="button" className="btn good" onClick={confirmSend} disabled={sendBusy} data-testid="dpd-preview-confirm">
            ✅ Potvrdiť a odoslať
          </button>
        </div>
      )}
    </section>
  );
}
