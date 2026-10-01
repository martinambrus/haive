/** A custom bundle as this install holds it: its local id, the source another install can find
 *  it by, and its items' local ids against their paths in that source. */
export interface LocalBundle {
  bundleId: string;
  source: string;
  items: ReadonlyMap<string, string>;
}

/** A claim whose bundle item this install does not hold: it claims its file, and no upgrade here
 *  offers anything for it. */
export const FOREIGN_TEMPLATE = 'foreign';

const LOCAL_CUSTOM = /^custom\.([^.]+)\.([^.]+)$/;
const PORTABLE_CUSTOM = 'custom:';

/** Where a bundle came from, the same on every install that ingested it. */
export function portableBundleSource(bundle: {
  sourceType: 'git' | 'zip';
  gitUrl: string | null;
  gitBranch: string | null;
  name: string;
}): string {
  // Each part is encoded on its own, since `#` is valid both in an scp-style remote path and in a
  // ref name: joined raw, one url#branch pair reads as another's.
  return bundle.sourceType === 'git'
    ? `git:${encodeURIComponent(bundle.gitUrl ?? '')}#${encodeURIComponent(bundle.gitBranch ?? '')}`
    : `zip:${encodeURIComponent(bundle.name)}`;
}

/** A template id another install can map back: Haive's own ids as they are, and a custom one
 *  (`custom.<bundleId>.<itemId>`, both local) as its bundle's source and the item's path in it.
 *  Null for a custom id whose bundle or item this install no longer holds. */
export function portableTemplateId(
  localId: string,
  bundles: readonly LocalBundle[],
): string | null {
  if (!localId.startsWith('custom.')) return localId;
  const match = LOCAL_CUSTOM.exec(localId);
  if (!match) return null;
  const bundle = bundles.find((b) => b.bundleId === match[1]);
  const sourcePath = bundle?.items.get(match[2]!);
  if (!bundle || sourcePath === undefined) return null;
  return `${PORTABLE_CUSTOM}${encodeURIComponent(bundle.source)}:${encodeURIComponent(sourcePath)}`;
}

/** The local template id for a portable one, or `FOREIGN_TEMPLATE` when this install holds no
 *  bundle item at that source and path, or holds that source in more than one bundle, since
 *  either could be meant. */
export function localTemplateId(portableId: string, bundles: readonly LocalBundle[]): string {
  if (!portableId.startsWith(PORTABLE_CUSTOM)) return portableId;
  const parts = portableId.slice(PORTABLE_CUSTOM.length).split(':');
  if (parts.length !== 2) return FOREIGN_TEMPLATE;
  let source: string;
  let sourcePath: string;
  try {
    source = decodeURIComponent(parts[0]!);
    sourcePath = decodeURIComponent(parts[1]!);
  } catch {
    return FOREIGN_TEMPLATE;
  }
  const holders = bundles.filter((b) => b.source === source);
  if (holders.length !== 1) return FOREIGN_TEMPLATE;
  const bundle = holders[0]!;
  for (const [itemId, path] of bundle.items) {
    if (path === sourcePath) return `custom.${bundle.bundleId}.${itemId}`;
  }
  return FOREIGN_TEMPLATE;
}
