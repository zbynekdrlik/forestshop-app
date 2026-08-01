import type { OrderLine, SupplierOpenOrders } from "./ordersApi.js";

// issue 66: predtým mala "Na objednanie" JEDEN zdieľaný string (`stateError`
// v `OrdersSection.tsx`) pre VŠETKÝCH 6 zápisových akcií tabu — každé ďalšie
// zlyhanie ho PREPÍSALO, takže manažér pri viacerých zlyhaniach za sebou
// (typický obraz krátkeho výpadku siete) videl vždy len POSLEDNÚ príčinu.
// Tento modul nahrádza jeden string ZOZNAMOM zlyhaní, kľúčovaným `id`
// (`<akcia>:<cieľ>`) — kumulatívne, kým sa položka buď znova neuloží úspešne,
// alebo ju manažér ručne nezavrie. Žiadna optimistická reconciliation
// (commitSeq a pod., ako legacy `app.js:1093-1240`) tu netreba — appka nikdy
// nezobrazí zápis ako uložený skôr, než ho server potvrdí (`checked={line
// .ordered}`/`<select value={line.state}>` v `OrderLineRow.tsx` sú viazané
// priamo na potvrdenú hodnotu z props, viď komentár na tickete #66).
export interface OrderWriteFailure {
  readonly id: string;
  readonly what: string;
  readonly where: string;
  readonly detail: string;
}

/** Pridá zlyhanie — rovnaké `id` NAHRADÍ predchádzajúcu položku (aktualizuje
 * dôvod), nikdy ju nezduplikuje. */
export function upsertWriteFailure(
  failures: readonly OrderWriteFailure[],
  failure: OrderWriteFailure,
): readonly OrderWriteFailure[] {
  return [...failures.filter((f) => f.id !== failure.id), failure];
}

/** Jeden zápis prišiel úspešne — zmaž LEN jeho položku (legacy `app.js`'s
 * `clearToOrderFail`: "ONE write landed — drop only ITS line"). */
export function clearWriteFailure(
  failures: readonly OrderWriteFailure[],
  id: string,
): readonly OrderWriteFailure[] {
  return failures.filter((f) => f.id !== id);
}

function pluralWord(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  return n >= 2 && n <= 4 ? few : many;
}

export function formatWriteFailuresHeading(count: number): string {
  return `⚠️ Nepodarilo sa uložiť ${String(count)} ${pluralWord(count, "položku", "položky", "položiek")}`;
}

function findLine(suppliers: readonly SupplierOpenOrders[], lineId: string): OrderLine | undefined {
  for (const group of suppliers) {
    const found = group.lines.find((l) => l.lineId === lineId);
    if (found !== undefined) return found;
  }
  return undefined;
}

// "obj. 20260910, kód 4859/46" — priamy náprotivok legacy `toOrderRowLabel`.
// Prázdny reťazec, keď riadok medzitým zmizol zo zoznamu (napr. iný manažér
// medzitým priradil dodávateľa a appka spravila refetch) — banner ukáže
// aspoň `what`, nikdy nespadne na chýbajúcom riadku.
export function lineWhere(suppliers: readonly SupplierOpenOrders[], lineId: string): string {
  const line = findLine(suppliers, lineId);
  return line === undefined ? "" : `obj. ${line.externalOrderId}, kód ${line.variantCode}`;
}

// Poznámka je vlastníctvom CELEJ objednávky (`orderId`), nie jedného riadku
// — stačí nájsť PRVÝ riadok s tým `orderId` (rovnaký vzor ako `OrdersSection
// .tsx`'s `changeComment`, ktoré tiež mutuje všetky riadky rovnakej objednávky).
export function orderWhere(suppliers: readonly SupplierOpenOrders[], orderId: string): string {
  for (const group of suppliers) {
    const found = group.lines.find((l) => l.orderId === orderId);
    if (found !== undefined) return `obj. ${found.externalOrderId}`;
  }
  return "";
}
