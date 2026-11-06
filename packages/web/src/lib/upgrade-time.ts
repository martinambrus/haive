/** Upgrade API instants must carry their offset; a zone-less wall clock is ambiguous. */
export function parseUpgradeInstant(iso: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(iso)
    ? Date.parse(iso)
    : NaN;
}
