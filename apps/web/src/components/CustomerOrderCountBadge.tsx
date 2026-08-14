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
  const n = String(count);
  return (
    <span
      className="cust-order-badge"
      data-testid={`cust-order-badge-${lineId}`}
      title={`zákazník má ${n} otvorené objednávky — zvážiť zlúčenie`}
      aria-label={`zákazník má ${n} otvorených objednávok — zvážiť zlúčenie`}
    >
      {count}
    </span>
  );
}
