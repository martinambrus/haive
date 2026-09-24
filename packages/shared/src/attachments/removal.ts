/** What a removal needs to know of each row to find the archives it would leave empty. */
export interface ExtractedFromLink {
  id: string;
  /** The archive this row came out of; null or absent for anything uploaded directly. */
  expandedFromId?: string | null;
}

/**
 * The archives a removal would leave with NONE of their extracted files: every row expanded from
 * them is doomed, and they are not doomed themselves.
 *
 * Folder-deleting an archive's expansion used to leave the archive listed and stamped as expanded,
 * with nothing of it left: it is never expanded again, and nothing told an agent its contents were
 * gone. So a removal that takes the last extracted file takes the archive too, and the one rule is
 * shared so the confirmation the person reads names exactly what the api removes. An archive that
 * never produced a file (over a cap, unreadable) has nothing to empty and is never returned.
 */
export function archivesEmptiedBy<T extends ExtractedFromLink>(
  rows: readonly T[],
  doomed: ReadonlySet<string>,
): T[] {
  const children = new Map<string, number>();
  const doomedChildren = new Map<string, number>();
  for (const row of rows) {
    const parent = row.expandedFromId;
    if (parent === null || parent === undefined) continue;
    children.set(parent, (children.get(parent) ?? 0) + 1);
    if (doomed.has(row.id)) doomedChildren.set(parent, (doomedChildren.get(parent) ?? 0) + 1);
  }
  return rows.filter((row) => {
    const total = children.get(row.id) ?? 0;
    return !doomed.has(row.id) && total > 0 && doomedChildren.get(row.id) === total;
  });
}
