export type CsvRecord = {
  cells: string[];
  rowNumber: number;
};

export type CsvDelimiter = "," | ";";

export class CsvSyntaxError extends Error {
  readonly rowNumber: number;

  constructor(message: string, rowNumber: number) {
    super(`CSV row ${rowNumber}: ${message}`);
    this.name = "CsvSyntaxError";
    this.rowNumber = rowNumber;
  }
}

// Bounded, quote-aware delimiter sniffing for locales (e.g. many
// non-English MyFlightbook exports) that use ";" as the list separator
// instead of ",". Only inspects the first record (respecting quoted
// fields, so a comma/semicolon inside a quoted value doesn't skew the
// count) and defaults to "," on a tie or when no semicolons are found, so
// comma-delimited ForeFlight/myFlightradar24/App-in-the-Air exports are
// never affected.
export function detectCsvDelimiter(input: string): CsvDelimiter {
  const text = input.replace(/^\uFEFF/, "");
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          index += 1;
        } else {
          inQuotes = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === "\r" || character === "\n") break;
    if (character === ",") commas += 1;
    else if (character === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

export function parseCsv(
  input: string,
  delimiter: CsvDelimiter = ",",
): CsvRecord[] {
  const text = input.replace(/^\uFEFF/, "");
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let rowNumber = 1;
  let recordStart = 1;
  let inQuotes = false;
  let closedQuote = false;

  const finishRecord = () => {
    cells.push(field);
    records.push({ cells, rowNumber: recordStart });
    cells = [];
    field = "";
    closedQuote = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (character === "\n") rowNumber += 1;
      }
      continue;
    }

    if (closedQuote && character !== delimiter && character !== "\r" && character !== "\n") {
      throw new CsvSyntaxError("unexpected character after closing quote", rowNumber);
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new CsvSyntaxError("quote encountered inside an unquoted field", rowNumber);
      }
      inQuotes = true;
      continue;
    }

    if (character === delimiter) {
      cells.push(field);
      field = "";
      closedQuote = false;
      continue;
    }

    if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRecord();
      rowNumber += 1;
      recordStart = rowNumber;
      continue;
    }

    field += character;
  }

  if (inQuotes) {
    throw new CsvSyntaxError("unterminated quoted field", recordStart);
  }

  if (field.length > 0 || cells.length > 0) finishRecord();
  return records;
}
