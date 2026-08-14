// issue 257 / issue 431: identita zákazníka naprieč objednávkami. Zhoda podľa
// `order.email` (orezané, malé písmená), keď objednávka e-mail MÁ; inak
// fallback na `order.customerName` (orezané, malé písmená) — staršie/
// hosťovské objednávky bez e-mailu (`order.email` je nepovinné,
// `schema-orders.ts`) by inak nikdy nešlo spárovať ako toho istého zákazníka,
// hoci zjavne patria jemu. Zákaznícke id v schéme NEEXISTUJE, takže identita
// je meno/e-mail.
//
// Vytiahnuté do vlastného (čistého, bez DB) modulu, aby ho zdieľali OBE
// funkcie, ktoré musia počítať "ten istý zákazník" ROVNAKO: `merge-mail.ts`
// (záložka "Zlúčenie objednávok", #257) aj `queries.ts`'s odznak s počtom
// otvorených objednávok v "Na objednanie" (#431). Keby každá mala vlastnú
// definíciu, odznak ("zváž zlúčenie") a samotné zlúčenie by mohli zákazníka
// zoskupovať rozdielne.
export function customerIdentityKey(email: string | null, customerName: string): string {
  const trimmedEmail = (email ?? "").trim().toLowerCase();
  if (trimmedEmail !== "") return `email:${trimmedEmail}`;
  return `name:${customerName.trim().toLowerCase()}`;
}
