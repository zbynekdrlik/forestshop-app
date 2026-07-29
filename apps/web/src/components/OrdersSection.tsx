import { useCallback, useEffect, useState, type JSX } from "react";
import {
  fetchOpenOrders,
  OrdersUnauthorizedError,
  type OrderLine,
  type SupplierOpenOrders,
} from "../ordersApi.js";

const STATE_LABELS: Record<OrderLine["state"], string> = {
  objednane: "Objednané",
  caka_sa: "Čaká sa",
  skladom: "Skladom",
  nedostupne: "Nedostupné",
};

// V1 je čisto na pozeranie (#24) — meniť stav riadku a kopírovať objednávku
// príde až s #25. Preto tu nie je žiadny formulár ani tlačidlo, len čítanie.
export function OrdersSection({
  onSessionExpired,
}: {
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const [suppliers, setSuppliers] = useState<readonly SupplierOpenOrders[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetchOpenOrders()
      .then((items) => {
        setSuppliers(items);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setLoaded(true);
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Otvorené objednávky sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  useEffect(load, [load]);

  // `/api/orders/open` už zoraďuje riadky presne tak, ako majú byť zobrazené
  // (dodávateľ vzostupne, potom najnovšia objednávka prvá) — žiadne ďalšie
  // preskupovanie na klientovi.
  const totalLines = suppliers.reduce((sum, group) => sum + group.lines.length, 0);

  return (
    <section>
      <h2>Na objednanie</h2>
      {!loaded && <p>Načítavam otvorené objednávky…</p>}
      {error !== "" && <p role="alert">{error}</p>}
      {loaded && totalLines === 0 && (
        <p data-testid="orders-empty">Zatiaľ nie sú žiadne otvorené objednávky.</p>
      )}
      {suppliers.map((group) => (
        <div key={group.supplier} data-testid={`supplier-${group.supplier}`}>
          <h3>{group.supplier}</h3>
          <table>
            <thead>
              <tr>
                <th>Objednávka</th>
                <th>Zákazník</th>
                <th>Kód</th>
                <th>Produkt</th>
                <th>Veľkosť</th>
                <th>Množstvo</th>
                <th>Stav</th>
                <th>Objednané</th>
                <th>Komentár</th>
              </tr>
            </thead>
            <tbody>
              {group.lines.map((line) => (
                <tr key={line.lineId} data-testid={`order-line-${line.lineId}`}>
                  <td>{line.externalOrderId}</td>
                  <td>{line.customerName}</td>
                  <td>{line.variantCode}</td>
                  <td>{line.variantName}</td>
                  <td>{line.sizeLabel ?? "—"}</td>
                  <td>{line.quantity}</td>
                  <td>{STATE_LABELS[line.state]}</td>
                  <td>{new Date(line.placedAt).toLocaleDateString("sk-SK")}</td>
                  <td>{line.comment ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
