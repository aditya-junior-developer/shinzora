/* ==========================================================================
   Shinzora — CSV
   --------------------------------------------------------------------------
   One parser and one writer, used by the catalogue import, the analytics
   report and the inventory export. Written by hand rather than pulled in,
   because the rules are short and a dependency would be larger than the file:

     * quoted fields, doubled quotes inside them, commas and newlines inside
       quotes (an address with a comma is the common case),
     * CRLF or LF line endings, a UTF-8 BOM from Excel,
     * a header row that names its columns in any order.

   The parser never guesses about types. Everything comes back as a string and
   the server decides what a number is — a browser that "helpfully" turns "007"
   into 7 would silently corrupt SKUs.
   ========================================================================== */

/** Split one CSV line into fields. Exported for tests. */
export function splitCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      fields.push(field);
      field = "";
      continue;
    }
    field += char;
  }
  fields.push(field);
  return fields;
}

/** Split a whole document into records, honouring quoted newlines. */
export function splitCsvRecords(text) {
  const records = [];
  let record = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      /* A doubled quote is an escaped quote and stays inside the field; it
         must not flip the quoted state, or the record after it is swallowed. */
      if (quoted && source[index + 1] === '"') {
        record += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
      record += char;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      records.push(record);
      record = "";
      continue;
    }
    record += char;
  }
  if (record.length) records.push(record);
  return records;
}

/**
 * Parse a CSV document into objects keyed by a normalised header.
 *
 * @param {string} text
 * @param {{ required?: string[] }} [options]
 * @returns {{ rows: Record<string,string>[], header: string[], error: string|null, skippedBlank: number }}
 */
export function parseCsv(text, options = {}) {
  const records = splitCsvRecords(text).filter((line) => line.trim() !== "");
  if (!records.length) return { rows: [], header: [], error: "The file is empty.", skippedBlank: 0 };

  const header = splitCsvLine(records[0]).map((name) => name.trim().toLowerCase().replace(/\s+/g, "_"));
  if (header.length < 2) {
    return { rows: [], header, error: "The first line must name at least two columns.", skippedBlank: 0 };
  }
  const required = (options.required || []).map((name) => name.toLowerCase());
  const missing = required.filter((name) => !header.includes(name));
  if (missing.length) {
    return { rows: [], header, error: `The file is missing the column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`, skippedBlank: 0 };
  }

  const rows = [];
  let skippedBlank = 0;
  for (const record of records.slice(1)) {
    const fields = splitCsvLine(record);
    if (fields.every((field) => field.trim() === "")) {
      skippedBlank += 1;
      continue;
    }
    const row = {};
    header.forEach((name, index) => {
      row[name] = (fields[index] ?? "").trim();
    });
    rows.push(row);
  }

  return { rows, header, error: null, skippedBlank };
}

/** Quote one value for output. Numbers are written as-is, everything else quoted. */
export function csvCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV document.
 *
 * @param {string[]} columns
 * @param {Array<Array<string|number>>} rows
 */
export function toCsv(columns, rows) {
  const head = columns.map(csvCell).join(",");
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

/** Hand a generated document to the browser as a download. */
export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.rel = "noopener";
  link.click();
  // Revoking immediately can cancel the download in Safari; one tick is enough.
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
