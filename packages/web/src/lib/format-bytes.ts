/** Human byte size, binary units.
 *
 *  Six local `formatBytes` copies already exist across the components tree, disagreeing on
 *  rounding (four use one decimal, two use none). This is deliberately NOT a refactor of
 *  those — it is the shared one for new callers, so the count stops growing.
 *
 *  One decimal from KB up, none for raw bytes: "1.5 KB" is useful and "1.5 B" is not. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
