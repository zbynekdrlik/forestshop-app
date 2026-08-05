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

export function computeStatus(row: UpozornenieStatusInput, now: Date): UpozornenieStatus {
  if (row.resolvedAt !== null) return "vybavene";
  if (row.postponedUntil !== null && row.postponedUntil.getTime() > now.getTime()) return "odlozene";
  if (row.seenAt === null) return "nove";
  return "otvorene";
}

// Odznak v ľavom menu aj predvolený filter "len nevybavené" ukazujú TO ISTÉ
// číslo (návrhové rozhodnutie na tickete): nevyriešené A práve NEODLOŽENÉ.
// Odložená karta sa do tohto počtu vráti sama v deň návratu (computeStatus
// vyššie), bez zásahu.
export function isActionableNow(row: UpozornenieStatusInput, now: Date): boolean {
  const status = computeStatus(row, now);
  return status === "nove" || status === "otvorene";
}
