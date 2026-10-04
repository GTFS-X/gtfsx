/**
 * "$2.50"-style label for a fare_attributes price, formatted in the fare's own
 * currency (C3-26: the label used to hardcode "$", so a EUR fare read
 * "$2.50 EUR"). Falls back to "2.50 XYZ" for a code Intl doesn't know.
 */
export function formatFarePrice(price: number | string, currency: string | undefined): string {
  const n = Number(price);
  const code = (currency || '').trim().toUpperCase();
  if (!Number.isFinite(n)) return `${price} ${code}`.trim();
  if (code) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(n);
    } catch {
      // Unknown or malformed ISO 4217 code: fall through.
    }
  }
  return `${n.toFixed(2)} ${code}`.trim();
}
