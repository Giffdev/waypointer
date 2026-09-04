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
  return readCsvRecords(input, { delimiter }).records;
}

export type ReadCsvRecordsOptions = {
  delimiter?: CsvDelimiter;
  /** Upper bound on logical records returned. */
  maxRecords?: number;
  /** Upper bound on characters consumed from `input`. */
  maxCharacters?: number;
  /**
   * What to do when the document is malformed.
   *
   * `"throw"` (default) is the import path: a broken file must fail loudly
   * rather than import a silently shortened logbook. `"truncate"` is the
   * *detection* path, where the question is only "what format is this?".
   * Throwing there discarded every record parsed before the error, so one
   * stray quote anywhere in a valid ForeFlight export scored every adapter at
   * zero and reported an unsupported format — a wrong answer about the file's
   * identity produced by a defect in its tail.
   */
  onSyntaxError?: "throw" | "truncate";
};

export type ReadCsvRecordsResult = {
  records: CsvRecord[];
  /**
   * True when a budget or a syntax error stopped the read before the end of
   * the input. Callers that scan for a marker must report "we stopped
   * reading" rather than "this format is unsupported": those are different
   * answers and only one of them is honest.
   */
  truncated: boolean;
  /** Set when `onSyntaxError: "truncate"` swallowed a malformed document. */
  syntaxError?: CsvSyntaxError;
};

export const DEFAULT_INSPECTION_RECORDS = 2000;
export const DEFAULT_INSPECTION_CHARACTERS = 1024 * 1024;

/**
 * Quote-aware, bounded, record-based reader.
 *
 * Detection used to slice the file into 256 *physical* lines. A ForeFlight
 * export with a large Aircraft Table — or any export with a multi-line quoted
 * remark — pushed the `Flights Table` marker past that window, the confidence
 * never reached the threshold, and a perfectly valid logbook was reported as
 * an unsupported format. Records, not lines, are the unit that matters, and
 * the budget is expressed in records and characters so the DoS ceiling is
 * preserved.
 */
export function readCsvRecords(
  input: string,
  options: ReadCsvRecordsOptions = {},
): ReadCsvRecordsResult {
  const {
    delimiter = ",",
    maxRecords = Number.POSITIVE_INFINITY,
    maxCharacters = Number.POSITIVE_INFINITY,
    onSyntaxError = "throw",
  } = options;
  const stripped = input.replace(/^\uFEFF/, "");
  const budgetedLength = Math.min(stripped.length, maxCharacters);
  const text = stripped.slice(0, budgetedLength);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let rowNumber = 1;
  let recordStart = 1;
  let inQuotes = false;
  let closedQuote = false;
  let stoppedEarly = budgetedLength < stripped.length;

  const finishRecord = () => {
    cells.push(field);
    records.push({ cells, rowNumber: recordStart });
    cells = [];
    field = "";
    closedQuote = false;
  };

  // Only the records completed *before* the fault survive lenient recovery.
  // The in-progress record is discarded rather than emitted half-parsed: a
  // partial record is worse than a missing one, because a caller cannot tell
  // the difference.
  const fail = (error: CsvSyntaxError): ReadCsvRecordsResult => {
    if (onSyntaxError === "throw") throw error;
    return { records, truncated: true, syntaxError: error };
  };

  for (let index = 0; index < text.length; index += 1) {
    if (records.length >= maxRecords) {
      stoppedEarly = true;
      return { records, truncated: stoppedEarly };
    }
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

    if (
      closedQuote &&
      character !== delimiter &&
      character !== "\r" &&
      character !== "\n"
    ) {
      return fail(
        new CsvSyntaxError(
          "unexpected character after closing quote",
          rowNumber,
        ),
      );
    }

    if (character === '"') {
      if (field.length > 0) {
        return fail(
          new CsvSyntaxError(
            "quote encountered inside an unquoted field",
            rowNumber,
          ),
        );
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
    // A truncated read can legitimately end mid-quote; that is a budget
    // outcome, not a malformed document.
    if (stoppedEarly) return { records, truncated: true };
    return fail(new CsvSyntaxError("unterminated quoted field", recordStart));
  }

  if (field.length > 0 || cells.length > 0) {
    if (stoppedEarly) return { records, truncated: true };
    finishRecord();
  }
  return { records, truncated: stoppedEarly };
}
