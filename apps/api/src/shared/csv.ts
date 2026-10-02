/** Parse comma-separated records without interpreting values or executing spreadsheet formulas. */
export function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else cell += char;
    } else if (afterQuote && char !== ',' && char !== '\n' && char !== '\r') {
      throw new Error('invalid_csv: CSV contains characters after a quoted field');
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === '"') throw new Error('invalid_csv: CSV contains a quote inside an unquoted field');
    else if (char === ',') {
      row.push(cell);
      cell = '';
      afterQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
      afterQuote = false;
    } else cell += char;
  }
  if (quoted) throw new Error('invalid_csv: CSV contains an unclosed quoted field');
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}
