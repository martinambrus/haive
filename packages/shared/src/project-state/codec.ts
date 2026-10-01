import type { z } from 'zod';
import { canonicalJson, sortedSet } from './canonical.js';
import { bundleFileName, claimFileName, isClaimablePath, isRecordName } from './names.js';
import {
  PROJECT_STATE_FORMAT,
  SET_SETTINGS,
  bundleSchema,
  claimSchema,
  cliSchema,
  emptyProjectState,
  environmentSchema,
  formatSchema,
  renderSchema,
  type ProjectRender,
  type ProjectStateBundle,
  type ProjectStateClaim,
  type ProjectStateRecord,
} from './record.js';

export class ProjectStateError extends Error {
  constructor(readonly problems: string[]) {
    super(`the project state record is not valid: ${problems.join('; ')}`);
  }
}

export type ProjectStateParse =
  | { ok: true; record: ProjectStateRecord; ignored: string[] }
  | { ok: false; reason: 'newer-format' | 'invalid'; problems: string[] };

const CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?: |$)|^={7}$/m;

const quote = (value: string): string => JSON.stringify(value);

/** What no record may hold, written or read. */
export function projectStateProblems(record: ProjectStateRecord): string[] {
  const problems: string[] = [];
  for (const provider of record.cli) {
    if (!isRecordName(provider)) problems.push(`cli: ${quote(provider)} is not a record name`);
  }
  for (const [name, value] of Object.entries(record.settings)) {
    if (!isRecordName(name)) {
      problems.push(`settings: ${quote(name)} is not a record name`);
    } else if (value === null || value === undefined) {
      problems.push(`settings/${name}.json: holds no value`);
    } else if (SET_SETTINGS.has(name) && !isStringList(value)) {
      problems.push(`settings/${name}.json: is not a list of strings`);
    }
  }
  const paths = new Set<string>();
  for (const claim of record.claims) {
    if (!isClaimablePath(claim.path)) {
      problems.push(`claim: ${quote(claim.path)} is not a repository path`);
    } else if (paths.has(claim.path)) {
      problems.push(`claim: ${quote(claim.path)} is claimed twice`);
    }
    paths.add(claim.path);
  }
  const sources = new Set<string>();
  for (const bundle of record.bundles) {
    if (sources.has(bundle.source))
      problems.push(`bundle: ${quote(bundle.source)} is listed twice`);
    sources.add(bundle.source);
  }
  return problems;
}

// Each file carries its schema's keys and no other, whatever object a caller hands in.
const renderOf = (r: ProjectRender): ProjectRender => ({
  projectInfo: r.projectInfo,
  framework: r.framework,
  acceptedAgentIds: sortedSet(r.acceptedAgentIds),
  customAgentSpecs: r.customAgentSpecs,
  lspLanguages: sortedSet(r.lspLanguages),
});
const claimOf = (c: ProjectStateClaim): ProjectStateClaim => ({
  path: c.path,
  templateId: c.templateId,
  kind: c.kind,
  schemaVersion: c.schemaVersion,
  templateHash: c.templateHash,
  writtenHash: c.writtenHash,
  haiveVersion: c.haiveVersion,
});
const bundleOf = (b: ProjectStateBundle): ProjectStateBundle => ({
  source: b.source,
  name: b.name,
});

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** The record as it is written: each object carrying its schema's keys alone, every set sorted
 *  and every list ordered by its key, so two equal states compare equal. */
export function normalizeProjectState(record: ProjectStateRecord): ProjectStateRecord {
  const settings: Record<string, unknown> = {};
  for (const name of Object.keys(record.settings).sort()) {
    const value = record.settings[name];
    settings[name] = SET_SETTINGS.has(name) && isStringList(value) ? sortedSet(value) : value;
  }
  return {
    environment: record.environment && {
      envDetectData: record.environment.envDetectData,
      confirmedValues: record.environment.confirmedValues,
    },
    render: record.render && renderOf(record.render),
    cli: sortedSet(record.cli),
    settings,
    claims: record.claims
      .map(claimOf)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    bundles: record.bundles
      .map(bundleOf)
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
  };
}

/** The record's files, relative to `PROJECT_STATE_DIR`, sorted by path. Throws
 *  `ProjectStateError` for a record no reader would accept. */
export function renderProjectState(record: ProjectStateRecord): Map<string, string> {
  const problems = projectStateProblems(record);
  if (problems.length > 0) throw new ProjectStateError(problems);
  const r = normalizeProjectState(record);
  const files = new Map<string, string>();
  files.set('format.json', canonicalJson({ schemaVersion: PROJECT_STATE_FORMAT }));
  if (r.environment) files.set('project/environment.json', canonicalJson(r.environment));
  if (r.render) files.set('project/render.json', canonicalJson(r.render));
  for (const provider of r.cli) files.set(`cli/${provider}.json`, canonicalJson({ provider }));
  for (const [name, value] of Object.entries(r.settings)) {
    files.set(`settings/${name}.json`, canonicalJson(value));
  }
  for (const claim of r.claims) files.set(claimFileName(claim.path), canonicalJson(claim));
  for (const bundle of r.bundles) files.set(bundleFileName(bundle.source), canonicalJson(bundle));
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

type FileKind =
  | { type: 'environment' | 'render' | 'claim' | 'bundle' }
  | { type: 'cli' | 'settings'; name: string };

function kindOf(rel: string): FileKind | null {
  if (rel === 'project/environment.json') return { type: 'environment' };
  if (rel === 'project/render.json') return { type: 'render' };
  const named = /^(cli|settings)\/([^/]+)\.json$/.exec(rel);
  if (named) return { type: named[1] as 'cli' | 'settings', name: named[2]! };
  if (/^artifacts\/[^/]+\.json$/.test(rel)) return { type: 'claim' };
  if (/^bundles\/[^/]+\.json$/.test(rel)) return { type: 'bundle' };
  return null;
}

const NOT_JSON = Symbol('not-json');

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function issues(rel: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${rel}: ${i.path.join('.') || 'the file'} ${i.message}`);
}

/** Reads the record from its files (relative to `PROJECT_STATE_DIR`), whole or not at all. Files
 *  no kind claims are left out and listed, so a newer release's additions are not refused. */
export function parseProjectState(files: ReadonlyMap<string, string>): ProjectStateParse {
  const marked = [...files]
    .filter(([, text]) => CONFLICT_MARKER.test(text))
    .map(([rel]) => `${rel}: holds merge conflict markers`)
    .sort();
  if (marked.length > 0) return { ok: false, reason: 'invalid', problems: marked };

  const formatText = files.get('format.json');
  if (formatText === undefined) {
    return { ok: false, reason: 'invalid', problems: ['format.json is missing'] };
  }
  const format = formatSchema.safeParse(readJson(formatText));
  if (!format.success)
    return { ok: false, reason: 'invalid', problems: issues('format.json', format.error) };
  if (format.data.schemaVersion > PROJECT_STATE_FORMAT) {
    return {
      ok: false,
      reason: 'newer-format',
      problems: [
        `format.json: format ${format.data.schemaVersion} is newer than ${PROJECT_STATE_FORMAT}, the newest this release reads`,
      ],
    };
  }

  const record = emptyProjectState();
  const problems: string[] = [];
  const ignored: string[] = [];
  for (const rel of [...files.keys()].sort()) {
    if (rel === 'format.json') continue;
    const kind = kindOf(rel);
    if (kind === null) {
      ignored.push(rel);
      continue;
    }
    const value = readJson(files.get(rel)!);
    if (value === NOT_JSON) {
      problems.push(`${rel}: is not JSON`);
      continue;
    }
    if (kind.type === 'settings') {
      record.settings[kind.name] = value;
      continue;
    }
    if (kind.type === 'environment') {
      const parsed = environmentSchema.safeParse(value);
      if (parsed.success) record.environment = parsed.data;
      else problems.push(...issues(rel, parsed.error));
    } else if (kind.type === 'render') {
      const parsed = renderSchema.safeParse(value);
      if (parsed.success) record.render = parsed.data;
      else problems.push(...issues(rel, parsed.error));
    } else if (kind.type === 'cli') {
      const parsed = cliSchema.safeParse(value);
      if (!parsed.success) problems.push(...issues(rel, parsed.error));
      else if (parsed.data.provider !== kind.name)
        problems.push(`${rel}: names ${quote(parsed.data.provider)}`);
      else record.cli.push(kind.name);
    } else if (kind.type === 'claim') {
      const parsed = claimSchema.safeParse(value);
      if (!parsed.success) problems.push(...issues(rel, parsed.error));
      else if (!isClaimablePath(parsed.data.path)) {
        problems.push(`${rel}: ${quote(parsed.data.path)} is not a repository path`);
      } else if (claimFileName(parsed.data.path) !== rel) {
        problems.push(`${rel}: is not the file for ${quote(parsed.data.path)}`);
      } else record.claims.push(parsed.data);
    } else {
      const parsed = bundleSchema.safeParse(value);
      if (!parsed.success) problems.push(...issues(rel, parsed.error));
      else if (bundleFileName(parsed.data.source) !== rel) {
        problems.push(`${rel}: is not the file for ${quote(parsed.data.source)}`);
      } else record.bundles.push(parsed.data);
    }
  }
  problems.push(...projectStateProblems(record));
  if (problems.length > 0) return { ok: false, reason: 'invalid', problems };
  return { ok: true, record: normalizeProjectState(record), ignored };
}
