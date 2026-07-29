// Vlastný parser, nie knižnica: export zo Shoptetu má zalomenia riadkov vnútri
// zacitovaných buniek (popisy sú HTML), koncové prázdne pole a CRLF — a beží nad
// 54 MB reťazcom, takže potrebujeme generátor, nie pole 14 014 × 265 reťazcov.

export function decodeCp1250(body: Buffer): string {
  // Node 24 má plné ICU, takže windows-1250 je vstavané — žiadna závislosť navyše.
  return new TextDecoder("windows-1250").decode(body);
}

export function* parseDelimited(text: string, delimiter = ";"): Generator<string[]> {
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false;
  let i = 0;

  while (i < text.length) {
    const ch = text.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // Aj \r a \n patria do bunky — presne kvôli tomuto je parser vlastný.
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      started = true;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      i += 1;
      if (started || field !== "" || row.length > 0) {
        row.push(field);
        yield row;
      }
      field = "";
      row = [];
      started = false;
      continue;
    }

    field += ch;
    started = true;
    i += 1;
  }

  if (started || field !== "" || row.length > 0) {
    row.push(field);
    yield row;
  }
}

export interface ShoptetCsv {
  readonly columns: readonly string[];
  rows(): Generator<Readonly<Record<string, string>>>;
}

function toRecord(
  columns: readonly string[],
  values: readonly string[],
): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const name = columns[i] ?? "";
    // Export končí bodkočiarkou, takže posledný stĺpec má prázdne meno — kľúč "" by
    // len zavádzal. Zoznam `columns` si ho ponecháva, aby počet sedel s exportom.
    if (name === "") continue;
    record[name] = values[i] ?? "";
  }
  return record;
}

export function parseShoptetCsv(body: Buffer): ShoptetCsv {
  const text = decodeCp1250(body);
  const first = parseDelimited(text).next();
  const columns: readonly string[] = first.done === true ? [] : first.value;

  return {
    columns,
    *rows(): Generator<Readonly<Record<string, string>>> {
      let isHeader = true;
      for (const values of parseDelimited(text)) {
        if (isHeader) {
          isHeader = false;
          continue;
        }
        yield toRecord(columns, values);
      }
    },
  };
}
