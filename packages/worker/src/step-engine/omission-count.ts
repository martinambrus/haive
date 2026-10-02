/** `atLeast`: the scan filled its limit, so the rows past it were never read. */
export function omissionCount(omitted: number, atLeast: boolean): string | null {
  if (omitted === 0 && !atLeast) return null;
  return omitted === 0 ? 'possibly' : atLeast ? `at least ${omitted}` : `${omitted}`;
}
