export type CsvRecord = {
  cells: string[];
  rowNumber: number;
};

export class CsvSyntaxError extends Error {
  readonly rowNumber: number;

  constructor(message: string, rowNumber: number) {
    super(`CSV row ${rowNumber}: ${message}`);
    this.name = "CsvSyntaxError";
    this.rowNumber = rowNumber;
  }
}

export function parseCsv(input: string): CsvRecord[] {
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

    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new CsvSyntaxError("unexpected character after closing quote", rowNumber);
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new CsvSyntaxError("quote encountered inside an unquoted field", rowNumber);
      }
      inQuotes = true;
      continue;
    }

    if (character === ",") {
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
