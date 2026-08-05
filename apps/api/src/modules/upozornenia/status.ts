// issue 267: "Upozornenia" — stav karty (Nové/Otvorené/Odložené/Vybavené)
// sa NEUKLADÁ ako vlastný stĺpec, počíta sa vždy nanovo z troch nullable
// timestampov. Dôvod (viď návrhový komentár na tickete): odložená karta sa
// má "v ten deň vrátiť späť" bez akejkoľvek novej naplánovanej úlohy — ticket
// to explicitne zakazuje ("Žiadna nová naplánovaná úloha"). Uložený stavový
// stĺpec by potreboval cron, čo ho o polnoci preklopí; počítaný stav je
// vždy správny pri čítaní, bez bežiaceho procesu.

export type UpozornenieStatus = "nove" | "otvorene" | "odlozene" | "vybavene";

export interface UpozornenieStatusInput {
  readonly seenAt: Date | null;
  readonly postponedUntil: Date | null;
  readonly resolvedAt: Date | null;
}

// [red] issue 267: zámerne nehotový stub — implementácia prichádza v
// nasledujúcom [green] commite, tento len dokazuje, že `status.test.ts`
// naozaj zlyhá bez skutočnej logiky.
export function computeStatus(_row: UpozornenieStatusInput, _now: Date): UpozornenieStatus {
  return "nove";
}

export function isActionableNow(_row: UpozornenieStatusInput, _now: Date): boolean {
  return false;
}
