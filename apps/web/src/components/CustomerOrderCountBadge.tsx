import type { JSX } from "react";

// issue 431: krúžkový odznak s počtom OTVORENÝCH objednávok toho istého
// zákazníka pri jeho mene v "Na objednanie" — signál "zváž zlúčenie do jednej
// zásielky" (obrazovka Zlúčenie objednávok existuje). Vizuál ako Shoptet modrý
// krúžok. Zobrazí sa LEN keď count ≥ 2 (jedna objednávka nie je dôvod na
// zlúčenie) — inak nevykreslí NIČ. Počet je autoritatívny z backendu
// (`customerOpenOrderCount`, zdieľaná identita zákazníka s "Zlúčenie
// objednávok"). Vyčlenené do vlastného súboru, aby `OrderLineRow.tsx` neprešlo
// cez eslint `max-lines: 400` (rovnaký vzor, akým vzniklo samotné
// `OrderLineRow.tsx` z `OrdersSection.tsx`).
export function CustomerOrderCountBadge({
  count,
  lineId,
}: {
  readonly count: number;
  readonly lineId: string;
}): JSX.Element | null {
  if (count < 2) return null;
  // Slovenské skloňovanie: 2-4 → "otvorené objednávky", 5+ → "otvorených
  // objednávok" (odznak sa zobrazuje len pri count ≥ 2, jednotné číslo netreba).
  // Tá istá 2-4 vs 5+ hranica ako `ordersSummary.ts`'s `formatOrderCount` —
  // ten skloňuje len holé "objednávky"/"objednávok" (bez prídavného mena),
  // tu ale musí súhlasiť aj prídavné meno "otvorené"/"otvorených", preto
  // krátka lokálna forma namiesto priameho volania. `title` aj `aria-label`
  // sú ZHODNÉ.
  const noun = count <= 4 ? "otvorené objednávky" : "otvorených objednávok";
  const label = `zákazník má ${String(count)} ${noun} — zvážiť zlúčenie`;
  return (
    <span
      className="cust-order-badge"
      data-testid={`cust-order-badge-${lineId}`}
      title={label}
      aria-label={label}
    >
      {count}
    </span>
  );
}
