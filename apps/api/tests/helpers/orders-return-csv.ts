// issue 269 (vydelené code review-om pri druhom spotrebiteľovi, TOCTOU
// zámkový test `orders-ingest-return-upozornenie-lock.integration.test.ts`):
// vrátkové stavy ("Vratený tovar" a pod.) nesú diakritiku, a `ingestOrders`
// VŽDY dekóduje ako windows-1250 (`decodeCp1250`) — obyčajný UTF-8 zápis by
// diakritiku na druhej strane pokazil (mojibake, `.claude/rules/orders.md`).
// Táto tabuľka (znak → byte) sa stavia DYNAMICKY dekódovaním všetkých 256
// bajtov cez `TextDecoder("windows-1250")` a obrátením mapy — žiadna nová
// závislosť (`iconv-lite`), žiadna ručne prepisovaná tabuľka kódových bodov.
// Zdieľané, aby ho oba súbory nemuseli stavať nezávisle dvakrát.
const CP1250_ENCODE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    const ch = new TextDecoder("windows-1250").decode(Buffer.from([byte]));
    if (!map.has(ch)) map.set(ch, byte);
  }
  return map;
})();

export function encodeCp1250(text: string): Buffer {
  return Buffer.from(Uint8Array.from(Array.from(text, (ch) => CP1250_ENCODE.get(ch) ?? 0x3f)));
}

export function buildReturnStatusCsv(header: readonly string[], rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [header.map(esc).join(";") + ";"];
  for (const row of rows) {
    lines.push(header.map((c) => esc(row[c] ?? "")).join(";") + ";");
  }
  return encodeCp1250(lines.join("\r\n") + "\r\n");
}

export const RETURN_STATUS_CSV_HEADER = ["code", "date", "statusName", "billFullName", "itemName", "itemAmount", "itemCode"] as const;

// `billFullName` je voliteľný (predvolene "Ján Novák") — issue 297's testy
// preukazujúce OBNOVU (nie preskočenie) po tom, čo zostal len JEDEN AKTÍVNY
// vrátkový stav ("Vratený tovar"), potrebujú zmeniť NIEČO medzi dvomi
// importmi TOHO ISTÉHO stavu, aby dôkaz obnovy nezávisel od zmeny titulku
// (predtým to robila zmena pod-stavu, dnes už neexistuje druhý AKTÍVNY).
export function returnStatusRowOf(code: string, statusName: string, billFullName = "Ján Novák"): Record<string, string> {
  return {
    code,
    date: "2026-06-15 10:30:00",
    statusName,
    billFullName,
    itemName: "Nohavice",
    itemAmount: "1",
    itemCode: "40237/XL",
  };
}
