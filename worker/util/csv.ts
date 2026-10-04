// One CSV cell, safe to open in a spreadsheet.
//
// Quotes the value when it contains a comma, quote or line break (RFC 4180),
// and neutralizes formula injection: a value starting with = + - @ TAB or CR
// is treated as a formula by Excel / Sheets / LibreOffice even inside quotes,
// so it gets a leading apostrophe (shown as text, not evaluated). Used by the
// staff CSV exports, whose cells carry user-controlled text (org names,
// display names, emails).

const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  if (value === '') return '';
  const s = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
