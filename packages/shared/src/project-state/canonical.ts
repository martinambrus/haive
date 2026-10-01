/** The one serialisation of a record file: keys sorted at every depth, two-space indent, LF, a
 *  trailing newline. Arrays keep their order; a set is sorted before it gets here. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}

/** Equal as the record would write them; `undefined` (absent) equals only itself. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

export const sortedSet = (values: readonly string[]): string[] => [...new Set(values)].sort();
