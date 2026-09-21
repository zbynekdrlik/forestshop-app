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
