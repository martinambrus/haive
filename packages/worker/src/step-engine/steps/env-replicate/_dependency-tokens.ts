import { assertVersionToken } from '@haive/shared';

/** Called on both newly declared and already stored dependencies. Empty pins retain the
 *  unpinned contract; nonempty input is checked before any runtime-specific resolution. */
export function assertDependencyTokens(deps: {
  versions?: Record<string, string | null>;
  lspServerVersions?: Record<string, string | null>;
  chromeDevtoolsMcpVersion?: string | null;
  browser?: { type?: string; version?: string | null };
  extraPackages?: string[];
  packageManagers?: Partial<Record<string, string | null>>;
  database?: { kind?: string; version?: string | null };
}): void {
  for (const [language, value] of Object.entries(deps.versions ?? {})) {
    if (value !== null && value !== '')
      assertVersionToken(
        value,
        `Runtime ${language} version (versions.${language}; edit the declared dependencies)`,
      );
  }
  for (const [server, value] of Object.entries(deps.lspServerVersions ?? {})) {
    if (value !== null && value !== '')
      assertVersionToken(value, `LSP ${server} version (edit the repository Tooling settings)`);
  }
  for (const value of [deps.chromeDevtoolsMcpVersion, deps.browser?.version]) {
    if (value !== undefined && value !== null && value !== '')
      assertVersionToken(
        value,
        'Browser or chrome-devtools-mcp version (edit the repository Tooling settings or declared dependencies)',
      );
  }
  for (const value of deps.extraPackages ?? [])
    assertVersionToken(value, 'Extra package name (edit the declared dependencies)');
  for (const [language, manager] of Object.entries(deps.packageManagers ?? {})) {
    if (!manager) continue;
    assertVersionToken(language, 'Dependency language name');
    assertVersionToken(manager, 'Package manager name');
  }
  if (deps.database?.kind) assertVersionToken(deps.database.kind, 'Database kind');
  if (
    deps.database?.version !== undefined &&
    deps.database.version !== null &&
    deps.database.version !== ''
  )
    assertVersionToken(
      deps.database.version,
      'Database version (databaseVersion; edit the declared dependencies)',
    );
}
