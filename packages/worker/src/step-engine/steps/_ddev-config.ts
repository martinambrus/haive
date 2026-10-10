// Shared parser for the handful of `.ddev/config.yaml` fields Haive reads
// (php/db/webserver/docroot): top-level scalars and one-level `database:` scalars,
// read with the `yaml` package. A document `yaml` reports errors for falls back to
// the line readers below. Shared by onboarding env detection (01-env-detect), the
// workflow DDEV reconcile step (07c-ddev-reconcile) and env-replicate
// (01-declare-deps) so all interpret the config identically.
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Document, Node, YAMLMap } from 'yaml';

/** Match a top-level `key: value` scalar (optionally double-quoted), line by line. */
function lineField(text: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

/** A scalar's text, never a coerced number (`8.10` stays `8.10`); null for a map, a sequence or an empty value. */
function scalarText(node: unknown, text: string): string | null {
  if (!isScalar(node) || typeof node.value !== 'string') return null;
  const value = node.value.trim();
  if (!value) return null;
  // A quoted " #" is not a comment; handed on whole with its quotes, 07c refuses it rather than reading the text before it.
  if (node.type?.startsWith('QUOTE') && /[ \t]#/.test(value) && node.range) {
    return text.slice(node.range[0], node.range[1]);
  }
  return value;
}

type Resolve = (node: unknown) => unknown;

/** Resolves an alias to the nearest anchor of its name before it, as YAML does, from one index of the
 *  document's anchors; `Alias.resolve` rescans the document on every call. Never expands an alias. */
function anchorResolver(doc: Document): Resolve {
  const anchors = new Map<string, { start: number; node: Node }[]>();
  visit(doc, (_key, node) => {
    const named = node as Node & { anchor?: string };
    if (!named.anchor || !named.range) return;
    const list = anchors.get(named.anchor) ?? [];
    list.push({ start: named.range[0], node: named });
    anchors.set(named.anchor, list);
  });
  return (node) => {
    if (!isAlias(node)) return node;
    const at = node.range?.[0] ?? Infinity;
    let found: Node | undefined;
    for (const entry of anchors.get(node.source) ?? []) if (entry.start < at) found = entry.node;
    return found;
  };
}

// yaml.v3's merge predicate: an untagged plain `<<`, or one tagged `!` or `!!merge`.
const isMergeKey = (key: unknown): boolean =>
  isScalar(key) &&
  key.value === '<<' &&
  ((key.type === 'PLAIN' && !key.tag) || key.tag === '!' || key.tag === 'tag:yaml.org,2002:merge');

/** `key` in `map` as yaml.v3 reads it: the map's own entry first, then each `<<` source in order. */
function lookup(map: YAMLMap, key: string, resolve: Resolve): unknown {
  // Depth-first with an explicit stack and one visit per map, so a long merge chain is neither deep nor exponential.
  const seen = new Set<YAMLMap>();
  const stack: YAMLMap[] = [map];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const own = current.items.find((pair) => {
      const name = resolve(pair.key);
      return !isMergeKey(pair.key) && isScalar(name) && name.value === key;
    });
    if (own) return resolve(own.value);
    const sources: YAMLMap[] = [];
    for (const pair of current.items) {
      if (!isMergeKey(pair.key)) continue;
      const source = resolve(pair.value);
      const listed = isSeq(source) ? source.items.map((item) => resolve(item)) : [source];
      for (const from of listed) if (isMap(from)) sources.push(from);
    }
    for (let i = sources.length - 1; i >= 0; i -= 1) stack.push(sources[i]!);
  }
  return undefined;
}

function topLevelMap(text: string): { resolve: Resolve; map: YAMLMap } | null {
  const doc = parseDocument(text, { schema: 'failsafe' });
  return doc.errors.length === 0 && isMap(doc.contents)
    ? { resolve: anchorResolver(doc), map: doc.contents }
    : null;
}

/** One parse of `text`; every read from it uses that parse, or the line readers when YAML refuses the document. */
function ddevReader(text: string) {
  const parsed = topLevelMap(text);
  return {
    field: (key: string): string | null =>
      parsed ? scalarText(lookup(parsed.map, key, parsed.resolve), text) : lineField(text, key),
    blockField: (block: string, key: string): string | null => {
      if (!parsed) return lineBlockField(text, block, key);
      const inner = lookup(parsed.map, block, parsed.resolve);
      return isMap(inner) ? scalarText(lookup(inner, key, parsed.resolve), text) : null;
    },
  };
}

/** Match a top-level `key: value` scalar as YAML reads it. */
export function matchYamlField(text: string, key: string): string | null {
  return ddevReader(text).field(key);
}

/** The DDEV project's primary URL derived from its `.ddev/config.yaml` WITHOUT
 *  booting the runner: `https://<name>.<project_tld>`. DDEV's primary_url is https
 *  on the default router, and Haive never customizes the scheme; `project_tld`
 *  defaults to `ddev.site` and is read from the config when overridden. Returns
 *  null when `name:` is absent. Best-effort prefill — the authoritative URL is
 *  still `ddev describe -j` (ddevPrimaryUrl) once the runner is up. */
export function ddevUrlFromConfigText(text: string): string | null {
  const read = ddevReader(text);
  const name = read.field('name');
  if (!name) return null;
  const tld = read.field('project_tld') ?? 'ddev.site';
  return `https://${name}.${tld}`;
}

/** A one-line YAML scalar's value: inside one pair of quotes, or bare up to any ` # comment`. */
function yamlScalarValue(rest: string): string | null {
  const line = rest.trimEnd();
  const quoted = /^(?:"([^"]*)"|'([^']*)')(?:[ \t]+#.*)?$/.exec(line);
  const inner = quoted ? (quoted[1] ?? quoted[2] ?? '') : null;
  // A quoted " #" is not a comment; handed on whole, the line is refused rather than read as the text before it.
  if (inner !== null && /[ \t]#/.test(inner)) return line;
  const value = inner ?? line.replace(/(?:^|[ \t])#.*$/, '');
  return value.trim() || null;
}

/** Match a `key: value` scalar one level inside a `block:` mapping, line by line. */
function lineBlockField(text: string, block: string, key: string): string | null {
  const blockRe = new RegExp(`^${block}:\\s*\\n((?:[ \\t]+.+\\r?\\n?)+)`, 'm');
  const blockMatch = text.match(blockRe);
  if (!blockMatch || !blockMatch[1]) return null;
  const inner = blockMatch[1];
  const fieldRe = new RegExp(`^[ \\t]+${key}:\\s*([^\\n]*)$`, 'm');
  const m = inner.match(fieldRe);
  return m ? yamlScalarValue(m[1] ?? '') : null;
}

/** Match a `key: value` scalar one level inside a `block:` mapping, as YAML reads the value. */
export function matchYamlBlockField(text: string, block: string, key: string): string | null {
  return ddevReader(text).blockField(block, key);
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
  const read = ddevReader(text);
  return {
    phpVersion: read.field('php_version'),
    dbType: read.blockField('database', 'type'),
    dbVersion: read.blockField('database', 'version'),
    webserver: read.field('webserver_type'),
    docroot: read.field('docroot'),
  };
}

export interface DdevConfigInput {
  /** Project name; slugified to a DNS-safe DDEV name. */
  name: string;
  /** DDEV project type (php, drupal, wordpress, laravel, …). Default 'php'. */
  type?: string | null;
  /** PHP version like '5.6' / '8.3'. Omitted (DDEV default) when null. */
  phpVersion?: string | null;
  /** Node.js version for the web container, like '22' or '22.11.0'. Omitted (DDEV's own
   *  default, 24 on ddev 1.25) when null or when it is not a plain numeric version — see
   *  isDdevNodejsVersion. */
  nodejsVersion?: string | null;
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

/** True for a value DDEV can actually install as `nodejs_version`.
 *
 *  DDEV hands the field to nvm inside the web container. MEASURED against the ddev 1.25.3
 *  binary: its own generated comment documents the accepted shape as `nodejs_version: "22"
 *  # or any version like "20", "18.16.0", etc.`, and its ONLY validation is
 *  "Node.js versions cannot contain whitespace" — so a range like `^22` passes DDEV and
 *  then fails inside the container, at `ddev start`, where nvm cannot resolve it.
 *
 *  That matters because the declared Node version reaches this from `package.json` engines
 *  via sanitizeVersion, which strips a leading `>=` but leaves a disjunction like
 *  '20 || ^22' intact. Rejecting anything but a plain numeric version and omitting the line
 *  leaves DDEV on its own default — exactly the behaviour before this field was written at
 *  all, which is the failure-safe direction. */
function isDdevNodejsVersion(raw: string): boolean {
  return /^\d+(\.\d+){0,2}$/.test(raw);
}

/** Slugify to a DNS-safe DDEV project name (lowercase alnum + hyphens). */
export function slugifyDdevName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'app';
}

/** Render a minimal `.ddev/config.yaml` from declared deps. Every field parseDdevConfig
 *  reads round-trips through this; `nodejs_version` is written but not parsed back, because
 *  nothing compares it — 07c-ddev-reconcile classifies non-database drift by hashing the
 *  whole authored `.ddev/` tree, and this file is written before 01c takes that baseline.
 *  DDEV fills the rest with its own defaults. Used by 01c-ddev-env to create DDEV for a
 *  project that declares it but has no config yet. */
export function renderDdevConfig(input: DdevConfigInput): string {
  const lines: string[] = [];
  lines.push(`name: ${slugifyDdevName(input.name)}`);
  lines.push(`type: ${input.type || 'php'}`);
  // Omit docroot when empty so DDEV auto-detects (and so it round-trips through
  // the regex parser, which can't read an empty-quoted scalar).
  if (input.docroot) lines.push(`docroot: "${input.docroot}"`);
  if (input.phpVersion) lines.push(`php_version: "${input.phpVersion}"`);
  const nodejsVersion = (input.nodejsVersion ?? '').trim();
  if (nodejsVersion && isDdevNodejsVersion(nodejsVersion)) {
    lines.push(`nodejs_version: "${nodejsVersion}"`);
  }
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
