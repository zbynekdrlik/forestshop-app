// issue 118: majiteľ, doslovne "📋 Kopírovať objednávku ✉️ Poslať objednávku
// e-mailom zatial skry este to nebudeme pouzivat" — appka ich SKRÝVA, nie
// MAŽE (funkcionalita aj testy ostávajú v kóde). Rovnaký princíp ako
// `nav.ts`'s `HIDDEN_TABS`: JEDEN prepínač na JEDNOM mieste, aby sa dal
// vrátiť jednou zmenou, bez hľadania po komponentoch.
//
// `SupplierActionsPanel.tsx` gejtuje obe tlačidlá + sprievodný text touto
// konštantou. Testy funkcionality (náhľad/odoslanie mailu, kopírovanie do
// schránky) mockujú TENTO modul na `true`
// (`vi.mock("./orderScreenFlags.js", () => ({ SHOW_ORDER_MAIL_ACTIONS: true }))`,
// `OrdersSection.mailActions.test.tsx`), aby zostali plne funkčné aj počas
// skrytia — appka samotná (a `OrdersSection.test.tsx`'s predvolený stav) ich
// necháva na `false`.
// Explicitná `boolean` anotácia (nie `false` literálový typ) — bez nej by
// TS zúžil typ na literál `false` a eslint's `@typescript-eslint/no-
// unnecessary-condition` by nahlásil KAŽDÉ `{SHOW_ORDER_MAIL_ACTIONS && ...}`
// v `SupplierActionsPanel.tsx` ako "vždy falošné", hoci zámerom je práve
// prepínateľná hodnota (`vi.mock` ju v testoch prepína na `true`).
export const SHOW_ORDER_MAIL_ACTIONS: boolean = false;
