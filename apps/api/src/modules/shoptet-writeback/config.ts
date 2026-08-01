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
