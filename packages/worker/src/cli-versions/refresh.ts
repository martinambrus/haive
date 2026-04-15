import { schema, type Database } from '@haive/database';
import {
  CLI_INSTALL_METADATA,
  CLI_PROVIDER_LIST,
  logger,
  type CliProviderName,
  type RefreshCliVersionsJobResult,
  type VersionSource,
} from '@haive/shared';
import { fetchGithubReleases, fetchNpmVersions, type FetchedVersions } from './fetcher.js';

const log = logger.child({ module: 'cli-version-refresh' });

async function fetchFromSource(source: VersionSource): Promise<FetchedVersions | null> {
  if (source.kind === 'npm') return fetchNpmVersions(source.package);
  if (source.kind === 'github-releases') {
    return fetchGithubReleases(source.repo, source.tagPrefix);
  }
  return null;
}

export async function refreshAllCliVersions(
  db: Database,
): Promise<RefreshCliVersionsJobResult> {
  const refreshed: RefreshCliVersionsJobResult['refreshed'] = [];
  const errors: RefreshCliVersionsJobResult['errors'] = [];

  for (const provider of CLI_PROVIDER_LIST) {
    const name = provider.name as CliProviderName;
    const meta = CLI_INSTALL_METADATA[name];
    const source = meta.versionSource;
    if (source.kind === 'none') continue;

    try {
      const fetched = await fetchFromSource(source);
      if (!fetched) continue;
      await db
        .insert(schema.cliPackageVersions)
        .values({
          name,
          versions: fetched.versions,
          latestVersion: fetched.latestVersion,
          fetchedAt: new Date(),
          fetchError: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.cliPackageVersions.name,
          set: {
            versions: fetched.versions,
            latestVersion: fetched.latestVersion,
            fetchedAt: new Date(),
            fetchError: null,
            updatedAt: new Date(),
          },
        });
      refreshed.push({
        name,
        count: fetched.versions.length,
        latest: fetched.latestVersion,
      });
      log.info(
        { name, count: fetched.versions.length, latest: fetched.latestVersion },
        'refreshed cli versions',
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      errors.push({ name, error });
      log.warn({ name, error }, 'failed to refresh cli versions');
      await db
        .insert(schema.cliPackageVersions)
        .values({
          name,
          versions: [],
          latestVersion: null,
          fetchedAt: null,
          fetchError: error,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.cliPackageVersions.name,
          set: {
            fetchError: error,
            updatedAt: new Date(),
          },
        });
    }
  }

  return { ok: errors.length === 0, refreshed, errors };
}
