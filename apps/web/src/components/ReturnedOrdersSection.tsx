import { useEffect, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchReturnedOrders, OrderFlagsUnauthorizedError, type OrderFlagRow } from "../orderFlagsApi.js";
import { OrderFlagTable } from "./OrderFlagTable.js";

// issue 290 → 516: "Eshop → Vrátený tovar" — READ-ONLY zoznam AKTÍVnych
// vrátení (stav "Vratený tovar", `modules/orders/order-flags.ts`). Issue 516
// (Štěpán) zúžilo pôvodné priradenie: sekcia teraz ukazuje len vrátenia, ktoré
// treba vybaviť, hotové "Vybavený Dobropis" sa už NEzobrazujú (zrkadlo #514 pri
// výmene). Žiadna mutácia — vybavovanie ostáva výhradne na nástenke Upozornenia.
// Štítok "nevybavené" (zdieľaný `OrderFlagTable`) ostáva funkčný: z aktívnych
// vrátení odlíši tie, čo majú ešte otvorenú "vratenie" kartu na Upozorneniach.
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
      <p>Objednávky, ktoré Shoptet eviduje v stave „Vratený tovar“ — aktívne vrátenia, ktoré treba vybaviť. Vybavené dobropisy („Vybavený Dobropis“) sa tu už nezobrazujú. Farebný štítok „nevybavené“ znamená, že na nástenke Upozornenia je k tejto objednávke ešte otvorená karta.</p>
      {rows.length === 0 ? (
        <p data-testid="returned-empty">Momentálne žiadny tovar nie je vrátený.</p>
      ) : (
        <OrderFlagTable testIdPrefix="returned-row" rows={rows} />
      )}
    </section>
  );
}
