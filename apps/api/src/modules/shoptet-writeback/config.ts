/**
 * Reálne Shoptet cesty (overené naživo proti https://www.forestshop.sk/admin/
 * pri návrhu #122, port zo sesterského `parovanie_produktov`'s
 * `scripts/shoptet_import.py` — `IMPORT_PATH`/`LOG_PATH` konštanty):
 * prihlasovacia stránka JE `${adminBaseUrl}/admin/`, import formulár
 * `${adminBaseUrl}/admin/import-produktov/`, log importov
 * `${adminBaseUrl}/admin/import-produktov/log/`.
 */
export interface ShoptetImportConfig {
  readonly loginUrl: string;
  readonly importUrl: string;
  readonly logUrl: string;
  readonly user: string;
  readonly password: string;
}

export function shoptetImportConfigFromBaseUrl(
  adminBaseUrl: string,
  user: string,
  password: string,
): ShoptetImportConfig {
  const base = adminBaseUrl.replace(/\/+$/, "");
  return {
    loginUrl: `${base}/admin/`,
    importUrl: `${base}/admin/import-produktov/`,
    logUrl: `${base}/admin/import-produktov/log/`,
    user,
    password,
  };
}

/**
 * Konfigurácia pre issue 123's spätný zápis poznámky (per-objednávka, nie
 * hromadný CSV import ako vyššie) — zdieľa PRIHLASOVACIU stránku aj
 * `SHOPTET_ADMIN_USER`/`PASSWORD` s #122 (žiadne nové premenné), ale
 * NEPOTREBUJE `importUrl`/`logUrl`. `adminBaseUrl` (bez koncového lomítka)
 * sa navyše nesie priamo — `order-note-playwright.ts` ho potrebuje pre
 * `buildShoptetAdminOrderUrl` (`modules/orders/queries.ts`), rovnaké
 * URL-skladanie appka už používa na obrazovke "Na objednanie".
 */
export interface OrderNoteWritebackConfig {
  readonly loginUrl: string;
  readonly adminBaseUrl: string;
  readonly user: string;
  readonly password: string;
}

export function orderNoteWritebackConfigFromBaseUrl(
  adminBaseUrl: string,
  user: string,
  password: string,
): OrderNoteWritebackConfig {
  const base = adminBaseUrl.replace(/\/+$/, "");
  return { loginUrl: `${base}/admin/`, adminBaseUrl: base, user, password };
}
