// issue 61/148 — vyňaté z `OrdersSection.tsx` (rovnaký dôvod ako existujúce
// hook-extrakcie `useSupplierEmailEditing.ts`/`useSupplierMailActions.ts`,
// `.claude/rules/frontend-design.md`): pridanie perzistencie vybraného
// dodávateľa (issue 148) poslalo `OrdersSection.tsx` cez eslint `max-lines:
// 400` — tieto ČISTÉ funkcie (žiadny React state/hook) sú najsamostatnejší
// vyňateľný blok.
//
// issue 61: kľúč pre prepínač "skryť vybavené riadky" — perzistovaný do
// localStorage. issue 148: vybraný dodávateľ (chip) dostáva PRESNE ten istý
// mechanizmus (predtým bol zámerne len klientský, komentár na tickete
// vysvetľuje zmenu).
const HIDE_RESOLVED_STORAGE_KEY = "forestshop.orders.hideResolved";
const SELECTED_SUPPLIER_STORAGE_KEY = "forestshop.orders.selectedSupplier";

export function readHideResolvedPreference(): boolean {
  try {
    return window.localStorage.getItem(HIDE_RESOLVED_STORAGE_KEY) === "1";
  } catch {
    // localStorage nedostupné (napr. prehliadač so zakázaným úložiskom) —
    // prepínač jednoducho nezačne predvyplnený, nič nespadne.
    return false;
  }
}

export function persistHideResolvedPreference(next: boolean): void {
  try {
    window.localStorage.setItem(HIDE_RESOLVED_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // localStorage nedostupné — voľba ostáva platná len pre túto reláciu.
  }
}

// issue 148: `null` (chýbajúci kľúč AJ prázdny reťazec) = "Všetci" — dodávateľ
// nikdy nemá prázdne meno, takže "" je bezpečný zástupný zápis pre "explicitne
// Všetci" bez potreby JSON parsovania jedného reťazca.
export function readSelectedSupplierPreference(): string | null {
  try {
    const stored = window.localStorage.getItem(SELECTED_SUPPLIER_STORAGE_KEY);
    return stored === null || stored === "" ? null : stored;
  } catch {
    return null;
  }
}

export function persistSelectedSupplier(next: string | null): void {
  try {
    window.localStorage.setItem(SELECTED_SUPPLIER_STORAGE_KEY, next ?? "");
  } catch {
    // localStorage nedostupné — voľba ostáva platná len pre túto reláciu.
  }
}
