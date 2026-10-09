/** `value` as one single-quoted bash word, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
