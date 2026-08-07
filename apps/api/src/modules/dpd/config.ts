/**
 * issue 292: prihlasovacie/cieľové adresy portálu `dpdshipper.sk` — rovnaký
 * vzor ako `shoptet-writeback/config.ts`. `baseUrl` bez koncového lomítka.
 */
export interface DpdPortalConfig {
  readonly loginUrl: string;
  readonly newShipmentUrl: string;
  readonly user: string;
  readonly password: string;
}

export function dpdPortalConfigFromBaseUrl(baseUrl: string, user: string, password: string): DpdPortalConfig {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    loginUrl: `${base}/login`,
    // "Pridať objednávku" — naživo overené (7.8.2026, read-only mapovanie,
    // `.claude/rules/dpd.md`): jediný formulár na založenie JEDNEJ zásielky
    // (Importné profily na hromadný súborový import boli na účte prázdne,
    // presný formát sa nedal zistiť bez zápisu, ktorý bezpečnostné pravidlo
    // tiketu zakazuje).
    newShipmentUrl: `${base}/shipments/0`,
    user,
    password,
  };
}
