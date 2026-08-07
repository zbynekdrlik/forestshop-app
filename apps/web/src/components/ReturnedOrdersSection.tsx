import { useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchReturnedOrders, OrderFlagsUnauthorizedError, type OrderFlagRow } from "../orderFlagsApi.js";
import { OrderFlagTable } from "./OrderFlagTable.js";

// issue 290: "Eshop → Vrátený tovar" — READ-ONLY zoznam objednávok v
// stave "Vratený tovar" (rozpracované) alebo "Vybavený Dobropis" (jeho
// hotová podoba), `modules/orders/order-flags.ts`. Rovnaký vzor ako
// `ExchangeOrdersSection.tsx` — žiadna mutácia, vybavovanie ostáva
// výhradne na nástenke Upozornenia.
export function ReturnedOrdersSection({ onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly OrderFlagRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchReturnedOrders()
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof OrderFlagsUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Zoznam vrátení sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  if (error !== "") return <p role="alert">{error}</p>;
  if (rows === null) return <p>Načítavam…</p>;

  return (
    <section>
      <p>Objednávky, ktoré Shoptet eviduje v stave „Vratený tovar“ alebo „Vybavený Dobropis“. Farebný štítok „nevybavené“ znamená, že na nástenke Upozornenia je k tejto objednávke ešte otvorená karta.</p>
      {rows.length === 0 ? (
        <p data-testid="returned-empty">Momentálne žiadny tovar nie je vrátený.</p>
      ) : (
        <OrderFlagTable testIdPrefix="returned-row" rows={rows} />
      )}
    </section>
  );
}
