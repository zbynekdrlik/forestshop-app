import { useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchExchangeOrders, OrderFlagsUnauthorizedError, type OrderFlagRow } from "../orderFlagsApi.js";
import { OrderFlagTable } from "./OrderFlagTable.js";

// issue 290 → 514: "Eshop → Výmena tovaru" — READ-ONLY zoznam AKTÍVnych
// výmen (stav "Výmena tovaru", `modules/orders/order-flags.ts`). Issue 514
// (Štěpán) invertovalo pôvodné priradenie na "Vybavená výmena": sekcia teraz
// ukazuje len výmeny, ktoré treba vybaviť, vybavené sa nezobrazujú. Žiadna
// mutácia tu. "Výmena tovaru" nezakladá "vratenie" kartu na Upozorneniach
// (`return-status.ts`), takže štítok "nevybavené" (zdieľaný `OrderFlagTable`)
// sa tu bežne nezobrazí — ostáva len pre zriedkavý prípad "Vratený tovar →
// Výmena tovaru" s lingering otvorenou kartou.
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
      <p>Objednávky, ktoré Shoptet eviduje v stave „Výmena tovaru“ — aktívne výmeny, ktoré treba vybaviť. Vybavené výmeny („Vybavená výmena“) sa tu už nezobrazujú.</p>
      {rows.length === 0 ? (
        <p data-testid="exchange-empty">Momentálne žiadna objednávka nie je vo výmene.</p>
      ) : (
        <OrderFlagTable testIdPrefix="exchange-row" rows={rows} />
      )}
    </section>
  );
}
