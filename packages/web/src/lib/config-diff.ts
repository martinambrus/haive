export function changedFields<T extends Record<string, unknown>>(
  loaded: T,
  current: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (current[key] !== loaded[key]) out[key] = current[key];
  }
  return out;
}
