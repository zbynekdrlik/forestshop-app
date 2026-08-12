import { useEffect, useRef, useState, type JSX } from "react";
import { fetchNextCalendarEvent, type NextCalendarEventResult } from "../calendarApi.js";

// issue 309: "Eshop → Upozornenia" — najbližšia udalosť z Google kalendára.
// Nezávislá karta od zoznamu DB-backed `upozornenie` kariet nižšie — vždy
// viditeľná na OBOCH záložkách ("Otvorené" aj "Vybavené"), keďže nejde o
// položku toho zoznamu (žiadny resolve/postpone).

export function NextCalendarEventCard(): JSX.Element | null {
  const [result, setResult] = useState<NextCalendarEventResult | null>(null);
  // `mountedRef` guard (`.claude/rules/frontend-design.md`'s vzor, issue
  // 251) — appka beží pod `<StrictMode>`, ktoré v dev móde efekt spustí,
  // zruší a znova spustí; bez tohto by sa mohol výsledok z PRVÉHO
  // (zrušeného) spustenia zapísať PO odmountovaní.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    fetchNextCalendarEvent()
      .then((r) => {
        if (mountedRef.current) setResult(r);
      })
      .catch(() => {
        // `fetchNextCalendarEvent` sama nikdy nezamietne (má vlastný
        // bezpečný default) — catch je len obrana pre eslint's
        // `no-floating-promises`, nikdy sa nemá reálne spustiť.
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Ešte sa nenačítalo, ALEBO appka nemá nakonfigurovaný kalendár — karta sa
  // vôbec nezobrazí (dispatch: "must NOT appear as broken/error card").
  if (result === null || !result.configured) return null;

  return (
    <div className="card next-calendar-event-card" data-testid="next-calendar-event">
      {result.error ? (
        <p className="next-calendar-event-row">Najbližšiu udalosť z kalendára sa nepodarilo načítať.</p>
      ) : result.events.length === 0 ? (
        <p className="next-calendar-event-row">V kalendári nie je žiadna nadchádzajúca udalosť.</p>
      ) : (
        // issue 382: až TRI najbližšie udalosti namiesto jednej — každá
        // vlastný kompaktný riadok (`.next-calendar-event-row`, žiadny
        // predvolený prehliadačový `<p>` margin), nie samostatné karty.
        result.events.map((event, i) => (
          <p className="next-calendar-event-row" key={`${event.dateLabel}-${event.title}-${String(i)}`}>
            📅 <strong>{event.dateLabel}</strong> — {event.title}
          </p>
        ))
      )}
    </div>
  );
}
