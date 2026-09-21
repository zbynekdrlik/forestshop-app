// issue 575 (review 🔵): JEDEN zdroj hodnôt stavu riadku pre klientske zod
// schémy — RUČNE zrkadlí `orderLineState.enumValues` z
// `apps/api/src/db/schema-orders.ts` (frontend a backend sú samostatné balíčky,
// žiadny zdieľaný typový balík medzi nimi, rovnaký vzor ako `NEZNAMY_DODAVATEL`).
// Predtým bol tento zoznam trikrát skopírovaný ako inline `z.enum([...])`
// (`ordersApi.ts` order+floor riadok, `floorNotesApi.ts` položka) — nová
// serverová hodnota enumu sa teraz doplní na JEDNOM mieste, inak by sa tri
// kópie časom rozišli. `as const` → `z.enum(...)` z neho odvodí úniu literálov,
// takže `OrderLine["state"]` typ (a jeho `STATE_LABELS`/`STATE_DISPLAY_ORDER`
// exhaustivita v `orderLineStateLabels.ts`) ostáva nezmenený.
export const ORDER_LINE_STATES = [
  "objednane",
  "caka_sa",
  "skladom",
  "nedostupne",
  "riesit",
  "objednane_stav",
] as const;

// issue 579: non-null hodnota stavu (drôtová hodnota, ktorú posiela POST
// `…/state`). `OrderLine["state"]` je od issue 579 NULLABLE (NULL = neoznačený
// východiskový stav, Štěpán), no settery/tlačidlá nikdy neposielajú NULL
// („odznačiť" je mimo zadania), preto majú tento úzky typ. `STATE_LABELS`/
// `STATE_DISPLAY_ORDER` sú tiež kľúčované ním (Record nesmie mať `null` kľúč).
export type OrderLineStateValue = (typeof ORDER_LINE_STATES)[number];
