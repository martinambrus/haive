// Shared, dependency-free parser for the handful of `.ddev/config.yaml` fields
// Haive reads (php/db/webserver/docroot). Regex-based on purpose — the worker
// carries no YAML dependency and these are flat top-level scalars or one-level
// `database:` block scalars. Shared by onboarding env detection (01-env-detect)
// and the workflow DDEV reconcile step (07c-ddev-reconcile) so both interpret
// the config identically.

/** Match a top-level `key: value` scalar (optionally double-quoted). */
export function matchYamlField(text: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

/** Match a `key: value` scalar one level inside a `block:` mapping. */
export function matchYamlBlockField(text: string, block: string, key: string): string | null {
  const blockRe = new RegExp(`^${block}:\\s*\\n((?:[ \\t]+.+\\n?)+)`, 'm');
  const blockMatch = text.match(blockRe);
  if (!blockMatch || !blockMatch[1]) return null;
  const inner = blockMatch[1];
  const fieldRe = new RegExp(`^[ \\t]+${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const m = inner.match(fieldRe);
  return m && m[1] ? m[1].trim() : null;
}

export interface DdevConfigFields {
  phpVersion: string | null;
  dbType: string | null;
  dbVersion: string | null;
  webserver: string | null;
  docroot: string | null;
}

/** Parse the DDEV config fields the reconcile step compares (php restart vs DB
 *  migrate). All null when absent — a config that declares none of them yields
 *  an all-null record that compares equal to another all-null record (no drift). */
export function parseDdevConfig(text: string): DdevConfigFields {
  return {
    phpVersion: matchYamlField(text, 'php_version'),
    dbType: matchYamlBlockField(text, 'database', 'type'),
    dbVersion: matchYamlBlockField(text, 'database', 'version'),
    webserver: matchYamlField(text, 'webserver_type'),
    docroot: matchYamlField(text, 'docroot'),
  };
}
