import { useEffect, useState, type JSX } from "react";
import { fetchOrdersOverview, OrdersUnauthorizedError, type OrdersOverview, type SupplierOpenOrders } from "../ordersApi.js";
import { countAffectedOrders, oldestWaitingPlacedAt, summarizeOrderLines } from "../ordersSummary.js";

// issue 237: blok dlaždíc NAD zoznamom na obrazovke "Na objednanie" — dve
// skupiny. "Prehľad e-shopu" (dnes/tento týždeň/tento mesiac, presne ako
// Shoptet-ov vlastný dashboard) je NEZÁVISLÝ od dodávateľského pracovného
// zoznamu — vlastný fetch (rovnaký tvar ako `OrderOpenStatusesPanel.tsx`:
// `useEffect`/`onSessionExpired`), lebo potrebuje VŠETKY objednávky (aj
// uzavreté), nie len OPEN-status podmnožinu, akú appka už má v `suppliers`.
// "Súhrn o objednávaní" NEPOTREBUJE žiadny nový fetch — počíta sa čisto z
// UŽ načítaných `suppliers` (rovnaké zdieľané funkcie ako `OrdersToolbar.tsx`
// používa pre svoj filter-viazaný súhrn, `ordersSummary.ts`).
//
// Dlaždice sú PREHĽAD, nikdy filter — kliknutie na ne nemení obsah zoznamu
// nižšie (ticketova explicitná požiadavka).
export function OrdersOverviewTiles({
  suppliers,
  onSessionExpired,
}: {
  readonly suppliers: readonly SupplierOpenOrders[];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [overview, setOverview] = useState<OrdersOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchOrdersOverview()
      .then((result) => {
        setOverview(result);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Prehľad e-shopu sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  const allLines = suppliers.flatMap((group) => group.lines);
  const ordering = summarizeOrderLines(allLines);
  const affectedOrders = countAffectedOrders(allLines);
  const oldestPlacedAt = oldestWaitingPlacedAt(allLines);

  return (
    <div className="orders-overview" data-testid="orders-overview">
      <div className="overview-group">
        <h2 className="overview-group-title">Prehľad e-shopu</h2>
        {error !== "" && <p role="alert">{error}</p>}
        {!loaded && error === "" && <p>Načítavam prehľad…</p>}
        {overview !== null && (
          <div className="overview-tiles">
            <OverviewTile testId="overview-shop-today" label="Dnes" orderCount={overview.today.orderCount} revenue={overview.today.revenue} />
            <OverviewTile testId="overview-shop-week" label="Tento týždeň" orderCount={overview.week.orderCount} revenue={overview.week.revenue} />
            <OverviewTile testId="overview-shop-month" label="Tento mesiac" orderCount={overview.month.orderCount} revenue={overview.month.revenue} />
          </div>
        )}
      </div>
      <div className="overview-group">
        <h2 className="overview-group-title">Súhrn o objednávaní</h2>
        <div className="overview-tiles">
          <SimpleTile testId="overview-ordering-remaining" label="Položiek na objednanie" value={String(ordering.remaining)} />
          <SimpleTile testId="overview-ordering-affected-orders" label="Dotknutých objednávok" value={String(affectedOrders)} />
          <SimpleTile testId="overview-ordering-already-ordered" label="Už objednané" value={String(ordering.ordered)} />
          <SimpleTile
            testId="overview-ordering-oldest"
            label="Najstaršia čakajúca"
            value={oldestPlacedAt === null ? "—" : new Date(oldestPlacedAt).toLocaleDateString("sk-SK")}
          />
        </div>
      </div>
    </div>
  );
}

function OverviewTile({
  testId,
  label,
  orderCount,
  revenue,
}: {
  readonly testId: string;
  readonly label: string;
  readonly orderCount: number;
  readonly revenue: string;
}): JSX.Element {
  return (
    <div className="overview-tile" data-testid={testId}>
      <p className="overview-tile-label">{label}</p>
      <p className="overview-tile-value">{`${String(orderCount)} objednávok`}</p>
      <p className="overview-tile-sub">{`${revenue} €`}</p>
    </div>
  );
}

function SimpleTile({ testId, label, value }: { readonly testId: string; readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div className="overview-tile" data-testid={testId}>
      <p className="overview-tile-label">{label}</p>
      <p className="overview-tile-value">{value}</p>
    </div>
  );
}
