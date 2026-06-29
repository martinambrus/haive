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

/** The DDEV project's primary URL derived from its `.ddev/config.yaml` WITHOUT
 *  booting the runner: `https://<name>.<project_tld>`. DDEV's primary_url is https
 *  on the default router, and Haive never customizes the scheme; `project_tld`
 *  defaults to `ddev.site` and is read from the config when overridden. Returns
 *  null when `name:` is absent. Best-effort prefill — the authoritative URL is
 *  still `ddev describe -j` (ddevPrimaryUrl) once the runner is up. */
export function ddevUrlFromConfigText(text: string): string | null {
  const name = matchYamlField(text, 'name');
  if (!name) return null;
  const tld = matchYamlField(text, 'project_tld') ?? 'ddev.site';
  return `https://${name}.${tld}`;
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

export interface DdevConfigInput {
  /** Project name; slugified to a DNS-safe DDEV name. */
  name: string;
  /** DDEV project type (php, drupal, wordpress, laravel, …). Default 'php'. */
  type?: string | null;
  /** PHP version like '5.6' / '8.3'. Omitted (DDEV default) when null. */
  phpVersion?: string | null;
  /** DB service type: mariadb | mysql | postgres. Omitted (DDEV default mariadb)
   *  for sqlite/none/null. */
  dbType?: string | null;
  dbVersion?: string | null;
  docroot?: string | null;
  webserverType?: string | null;
  /** On-demand step-debugging (Lane C1): when true, emit a web_environment entry
   *  setting NODE_OPTIONS so a Node process running INSIDE the DDEV web container
   *  opens an inspector on 0.0.0.0:9229 (reachable from the Editor tab via the
   *  runner forward). Only meaningful for projects that run Node under DDEV. */
  nodeInspect?: boolean;
}

const DDEV_DB_TYPES = new Set(['mariadb', 'mysql', 'postgres']);

/** Slugify to a DNS-safe DDEV project name (lowercase alnum + hyphens). */
export function slugifyDdevName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'app';
}

/** Render a minimal `.ddev/config.yaml` from declared deps. Emits exactly the
 *  fields parseDdevConfig reads (round-trips); DDEV fills the rest with its own
 *  defaults. Used by 01c-ddev-env to create DDEV for a project that declares it
 *  but has no config yet. */
export function renderDdevConfig(input: DdevConfigInput): string {
  const lines: string[] = [];
  lines.push(`name: ${slugifyDdevName(input.name)}`);
  lines.push(`type: ${input.type || 'php'}`);
  // Omit docroot when empty so DDEV auto-detects (and so it round-trips through
  // the regex parser, which can't read an empty-quoted scalar).
  if (input.docroot) lines.push(`docroot: "${input.docroot}"`);
  if (input.phpVersion) lines.push(`php_version: "${input.phpVersion}"`);
  lines.push(`webserver_type: ${input.webserverType || 'nginx-fpm'}`);
  const dbType = input.dbType && DDEV_DB_TYPES.has(input.dbType) ? input.dbType : null;
  if (dbType) {
    lines.push('database:');
    lines.push(`  type: ${dbType}`);
    if (input.dbVersion) lines.push(`  version: "${input.dbVersion}"`);
  }
  if (input.nodeInspect) {
    lines.push('web_environment:');
    lines.push('  - "NODE_OPTIONS=--inspect=0.0.0.0:9229"');
  }
  return lines.join('\n') + '\n';
}
