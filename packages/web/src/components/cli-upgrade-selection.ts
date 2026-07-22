import type { CliProvider, CliProviderCatalogEntry, CliProviderName } from '@/lib/api-client';

/** Returns the newest available version to upgrade to, or null when none.
 *  Target is versions[0] (newest published), NOT the dist-tag latestVersion,
 *  which can lag behind the newest publish. Offered only when the pin is a
 *  KNOWN, older entry (idx > 0): idx 0 = already newest; idx -1 = pinned to
 *  something not in the cache (e.g. ahead of the registry list) → no offer, so
 *  we never prompt a downgrade. Unpinnable providers never report an upgrade. */
export function cliUpgradeLatest(
  p: CliProvider,
  meta: CliProviderCatalogEntry | undefined,
): string | null {
  if (!meta?.versionPinnable) return null;
  const versions = meta.versionCache?.versions ?? [];
  const installed = p.cliVersion;
  if (!installed || versions.length === 0) return null;
  return versions.indexOf(installed) > 0 ? versions[0]! : null;
}

export interface UpgradableRow {
  id: string;
  label: string;
  from: string;
  to: string;
}

export interface UpgradeGroup {
  name: CliProviderName;
  rows: UpgradableRow[];
}

/** Group every provider with a pending version upgrade by CLI type, keeping the
 *  order the providers arrive in. Types with no upgradable row are omitted, so
 *  `groups.length === 0` means "nothing to upgrade" and the bulk control hides.
 *  `from` is non-null by construction: cliUpgradeLatest only returns a target
 *  for a provider that already has a pinned version. */
export function groupUpgradable(
  providers: CliProvider[],
  catalog: CliProviderCatalogEntry[],
): UpgradeGroup[] {
  const groups = new Map<CliProviderName, UpgradeGroup>();
  for (const p of providers) {
    const to = cliUpgradeLatest(
      p,
      catalog.find((m) => m.name === p.name),
    );
    if (!to || !p.cliVersion) continue;
    let group = groups.get(p.name);
    if (!group) {
      group = { name: p.name, rows: [] };
      groups.set(p.name, group);
    }
    group.rows.push({ id: p.id, label: p.label, from: p.cliVersion, to });
  }
  return [...groups.values()];
}
