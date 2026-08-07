import { useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchExchangeOrders, OrderFlagsUnauthorizedError, type OrderFlagRow } from "../orderFlagsApi.js";
import { OrderFlagTable } from "./OrderFlagTable.js";

// issue 290: "Eshop → Výmena tovaru" — READ-ONLY zoznam objednávok v stave
// "Vybavená výmena" (jediný priradený stav, `modules/orders/order-flags
// .ts`). Žiadna mutácia tu — vybavovanie ostáva výhradne na nástenke
// Upozornenia (`return-status.ts`/#267/#269/#297), táto obrazovka len
// ZOBRAZUJE tie isté objednávky + či majú ešte otvorenú kartu.
export function ExchangeOrdersSection({ onSessionExpired }: { readonly role: Me["role"]; readonly onSessionExpired: () => void }): JSX.Element {
  const [rows, setRows] = useState<readonly OrderFlagRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchExchangeOrders()
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof OrderFlagsUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setError("Zoznam výmen sa nepodarilo načítať.");
      });
  }, [onSessionExpired]);

  if (error !== "") return <p role="alert">{error}</p>;
  if (rows === null) return <p>Načítavam…</p>;

  return (
    <section>
      <p>Objednávky, ktoré Shoptet eviduje v stave „Vybavená výmena“. Farebný štítok „nevybavené“ znamená, že na nástenke Upozornenia je k tejto objednávke ešte otvorená karta.</p>
      {rows.length === 0 ? (
        <p data-testid="exchange-empty">Momentálne žiadna objednávka nie je vo výmene.</p>
      ) : (
        <OrderFlagTable testIdPrefix="exchange-row" rows={rows} />
      )}
    </section>
  );
}
