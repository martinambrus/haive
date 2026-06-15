import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/** Per-tool available-version cache, mirroring `cli_package_versions`. Keyed by
 *  the tool's stable name (ToolName: rtk, chrome-devtools-mcp, intelephense,
 *  vtsls, pyright, gopls, solargraph). Free-text PK (not a pgEnum) so adding a
 *  tool needs no enum migration. Populated by the worker version-refresh job.
 *  `latestSha256` is used only by rtk (GitHub release checksum) and is null for
 *  registry-based tools. */
export const toolPackageVersions = pgTable('tool_package_versions', {
  name: text('name').primaryKey(),
  versions: jsonb('versions').$type<string[]>().notNull().default([]),
  latestVersion: text('latest_version'),
  latestSha256: text('latest_sha256'),
  fetchedAt: timestamp('fetched_at'),
  fetchError: text('fetch_error'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
