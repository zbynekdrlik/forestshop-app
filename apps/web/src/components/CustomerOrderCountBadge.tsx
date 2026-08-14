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
  // Slovenské skloňovanie: 2-4 → "objednávky", 5+ → "objednávok" (odznak sa
  // zobrazuje len pri count ≥ 2, jednotné číslo teda netreba). Rovnaký 2-4 vs
  // 5+ rozdiel ako backendový `pluralWord` (`apps/api`'s `orders/pluralize.ts`)
  // — frontend a backend sú samostatné balíčky bez zdieľaného kódu, preto
  // krátka lokálna forma namiesto importu. `title` aj `aria-label` sú ZHODNÉ.
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
