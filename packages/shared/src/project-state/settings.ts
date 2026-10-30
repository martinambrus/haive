import { stripManagedKnowledgeGlobs, trimGlobSlashes } from '../knowledge-paths.js';
import { normalizeReviewDimensionIds } from '../review/dimensions.js';
import { normalizeContent } from '../templates/normalize-content.js';
import { LSP_KEY_SET } from '../tooling/lsp-servers.js';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_CONSENT_KEYS,
  ONBOARDING_TOOLING_INFRA_KEYS,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  mirroredEnvDetectData,
  type OnboardingEnvironmentMirror,
} from '../types/index.js';
import { canonicalJson, sameValue } from './canonical.js';
import { MAX_AGENT_RULES_BYTES, PROJECT_STATE_LIMITS } from './limits.js';
import { hasConflictMarker } from './raw-text.js';
import type { ProjectEnvironment } from './record.js';

/** The record's portable settings, by file name. App login and verify commands are left out on
 *  purpose: a committed value of either would run on a teammate's machine. */
export const PORTABLE_SETTING_NAMES = [
  'scope-exclude-globs',
  'rtk-enabled',
  'rtk-version',
  'lsp-servers',
  'lsp-server-versions',
  'chrome-devtools-mcp-version',
  'review-dimensions',
  'agent-rules',
] as const;

export type PortableSettingName = (typeof PORTABLE_SETTING_NAMES)[number];

/** The columns of a `repositories` row that hold a portable setting. */
export interface PortableSettingColumns {
  scopeExcludeGlobs: unknown;
  rtkEnabled: unknown;
  rtkVersion: unknown;
  lspServers: unknown;
  lspServerVersions: unknown;
  chromeDevtoolsMcpVersion: unknown;
  reviewDimensions: unknown;
  agentRulesOverride: unknown;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const isVersionMap = (value: unknown): value is Record<string, string | null> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => v === null || typeof v === 'string');

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The settings a repository row holds, by record name. A column holding nothing (or nothing a
 *  reader could take) has no entry, so its file is not written. */
export function portableSettingsOf(row: PortableSettingColumns): Record<string, unknown> {
  const settings = Object.create(null) as Record<string, unknown>;
  if (isStringList(row.scopeExcludeGlobs)) settings['scope-exclude-globs'] = row.scopeExcludeGlobs;
  if (typeof row.rtkEnabled === 'boolean') settings['rtk-enabled'] = row.rtkEnabled;
  if (typeof row.rtkVersion === 'string') settings['rtk-version'] = row.rtkVersion;
  if (isStringList(row.lspServers)) settings['lsp-servers'] = row.lspServers;
  if (isVersionMap(row.lspServerVersions)) settings['lsp-server-versions'] = row.lspServerVersions;
  if (typeof row.chromeDevtoolsMcpVersion === 'string') {
    settings['chrome-devtools-mcp-version'] = row.chromeDevtoolsMcpVersion;
  }
  if (isStringList(row.reviewDimensions)) settings['review-dimensions'] = row.reviewDimensions;
  // '' is an explicit override, so a column holds nothing only when it is not text.
  if (typeof row.agentRulesOverride === 'string') settings['agent-rules'] = row.agentRulesOverride;
  return settings;
}

/** Without `rtk-enabled` unless the repository's RTK choice is recorded: `rtk_enabled` is NOT NULL
 *  default true, so a column nobody chose must neither travel nor count as this install's value. */
export function withoutUnchosenRtk(
  settings: Readonly<Record<string, unknown>>,
  rtkChoiceRecorded: boolean,
): Record<string, unknown> {
  const out = Object.assign(Object.create(null) as Record<string, unknown>, settings);
  if (!rtkChoiceRecorded) delete out['rtk-enabled'];
  return out;
}

/** The environment unit from `repositories.onboarding_environment` (the mirror without its
 *  schema version), or null when the column holds none a reader of this release takes. */
export function environmentUnitOf(column: unknown): ProjectEnvironment | null {
  if (!plainObject(column) || column.schemaVersion !== ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) {
    return null;
  }
  const { envDetectData, confirmedValues } = column;
  if (!plainObject(envDetectData) || !plainObject(confirmedValues)) return null;
  return { envDetectData, confirmedValues };
}

/** The onboarding tooling's name in the record's settings. It is no portable setting: a whole-value
 *  unit that is never merged, so it has no conflict row and no column mapping of its own. */
export const TOOLING_UNIT_NAME = 'onboarding-tooling';

/** The tooling without the keys that stay on this machine: infrastructure addresses and this
 *  install's MCP consent. */
export function withoutMachineLocalTooling(
  tooling: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tooling };
  for (const key of [...ONBOARDING_TOOLING_INFRA_KEYS, ...ONBOARDING_TOOLING_CONSENT_KEYS]) {
    delete out[key];
  }
  return out;
}

/** The tooling unit from `repositories.onboarding_tooling`, or null when the column holds none a
 *  reader of this release takes or the file would not be read back. A server list held for consent is
 *  committed under `mcpSettingsJson`, the key the other installs read, so this install's hold does not
 *  take the team's list out of the record. */
export function toolingUnitOf(column: unknown): Record<string, unknown> | null {
  if (!plainObject(column) || column.schemaVersion !== ONBOARDING_TOOLING_SCHEMA_VERSION) {
    return null;
  }
  if (!plainObject(column.tooling)) return null;
  const held = column.tooling.importedMcpSettingsJson;
  const unit = withoutMachineLocalTooling(column.tooling);
  if (typeof held === 'string' && typeof unit.mcpSettingsJson !== 'string') {
    unit.mcpSettingsJson = held;
  }
  return Buffer.byteLength(canonicalJson(unit), 'utf8') > PROJECT_STATE_LIMITS.maxFileBytes
    ? null
    : unit;
}

/** The tooling unit a checkout holds, or null when its value is no object. */
export const toolingUnitFrom = (value: unknown): Record<string, unknown> | null =>
  plainObject(value) ? value : null;

const COLUMN_OF = {
  'scope-exclude-globs': 'scopeExcludeGlobs',
  'rtk-enabled': 'rtkEnabled',
  'rtk-version': 'rtkVersion',
  'lsp-servers': 'lspServers',
  'lsp-server-versions': 'lspServerVersions',
  'chrome-devtools-mcp-version': 'chromeDevtoolsMcpVersion',
  'review-dimensions': 'reviewDimensions',
  'agent-rules': 'agentRulesOverride',
} as const satisfies Record<(typeof PORTABLE_SETTING_NAMES)[number], keyof PortableSettingColumns>;

export const isPortableSettingName = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(COLUMN_OF, name);

/** Settings an import never unsets: a column that cannot hold nothing, and the scope list, which is
 *  NULL only while nobody chose one, so another install's silence says nothing about it. */
const NEVER_UNSET: ReadonlySet<string> = new Set(['rtk-enabled', 'scope-exclude-globs']);
export const isUnsettableSetting = (name: string): boolean => !NEVER_UNSET.has(name);

const nonEmptyText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export type SettingCheck = { ok: true; value: unknown } | { ok: false; reason?: string };

export type AgentRulesCheck = { ok: true; value: string } | { ok: false; reason: string };

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** The text the repository's AGENTS.md rules override is stored as: tidied the way every managed file
 *  is, so storing it again changes nothing. '' is kept, an explicit override that renders no block.
 *  Refused is text that is not well-formed, that would end or start a Haive region early, that the
 *  record reads as a merge conflict marker (a setext underline of seven `=` is one) or that is over
 *  `MAX_AGENT_RULES_BYTES`. */
export function normalizeAgentRulesOverride(value: unknown): AgentRulesCheck {
  if (typeof value !== 'string') return refuse('is not text');
  if (!value.isWellFormed()) return refuse('holds a lone surrogate');
  if (value.includes('\u0000')) return refuse('holds a NUL character');
  const unix = value.replace(/^\uFEFF+/, '').replace(/\r\n?/g, '\n');
  if (unix.trim() === '') return { ok: true, value: '' };
  const text = normalizeContent(unix);
  // `\s*\/?\s*` reads the same strings but backtracks quadratically on a long run of whitespace.
  if (/<!--\s*(?:\/\s*)?haive:/.test(text)) {
    return refuse(
      'holds a Haive region marker comment (<!-- haive:name -->), which would end or start a region early',
    );
  }
  if (hasConflictMarker(text)) {
    return refuse(
      'holds a line of exactly seven =, <, > or | characters, which reads as a merge conflict marker',
    );
  }
  if (new TextEncoder().encode(text).length > MAX_AGENT_RULES_BYTES) {
    return refuse(`is larger than ${MAX_AGENT_RULES_BYTES / 1024} KiB`);
  }
  return { ok: true, value: text };
}

/** A setting as the column stores it, by the same rules the repository routes apply to what a person
 *  sends; `ok: false` for a value the column could not hold, with a `reason` where the setting has one. */
export function normalizeSetting(name: string, value: unknown): SettingCheck {
  const valid = (v: unknown): SettingCheck => ({ ok: true, value: v });
  switch (name) {
    case 'scope-exclude-globs':
      return isStringList(value)
        ? valid(
            stripManagedKnowledgeGlobs([
              ...new Set(value.map(trimGlobSlashes).filter((g) => g.length > 0)),
            ]).sort(),
          )
        : { ok: false };
    case 'rtk-enabled':
      return typeof value === 'boolean' ? valid(value) : { ok: false };
    case 'rtk-version':
    case 'chrome-devtools-mcp-version': {
      const text = nonEmptyText(value);
      return text === null ? { ok: false } : valid(text);
    }
    case 'lsp-servers':
      return isStringList(value)
        ? valid([...new Set(value.filter((s) => LSP_KEY_SET.has(s)))])
        : { ok: false };
    case 'lsp-server-versions': {
      if (!isVersionMap(value)) return { ok: false };
      const clean: Record<string, string> = {};
      for (const [key, version] of Object.entries(value)) {
        const text = nonEmptyText(version);
        if (LSP_KEY_SET.has(key) && text !== null) clean[key] = text;
      }
      return valid(clean);
    }
    case 'review-dimensions': {
      const ids = isStringList(value) ? normalizeReviewDimensionIds(value) : [];
      return ids.length === 0 ? { ok: false } : valid(ids);
    }
    case 'agent-rules': {
      const checked = normalizeAgentRulesOverride(value);
      return checked.ok ? valid(checked.value) : checked;
    }
    default:
      return { ok: false };
  }
}

/** The `repositories` columns to write so a repository holds `value` for the setting (undefined:
 *  unset it), or null when there is nothing to write: an unknown name, a value the column cannot hold,
 *  or a setting that is never unset. */
export function settingColumnUpdate(
  name: string,
  value: unknown,
): Partial<Record<keyof PortableSettingColumns, unknown>> | null {
  if (!isPortableSettingName(name)) return null;
  const column = COLUMN_OF[name as keyof typeof COLUMN_OF];
  if (value === undefined) return isUnsettableSetting(name) ? { [column]: null } : null;
  const checked = normalizeSetting(name, value);
  return checked.ok ? { [column]: checked.value } : null;
}

export interface SettingsIntake {
  /** What the merge sees as the checkout's: each valid setting normalised, the rest as this install
   *  holds them, so that they move nothing. */
  incoming: Record<string, unknown>;
  /** The checkout's settings, normalised, that a base may keep: the valid ones. */
  accepted: Record<string, unknown>;
  /** Names whose checkout value no column could hold; left unimported. */
  rejected: string[];
}

/** Reads the checkout's portable settings against this install's. A name it does not hold stays as
 *  this install has it when that setting is never unset, and a value that is not valid is left out. */
export function intakeSettings(
  checkout: Readonly<Record<string, unknown>>,
  local: Readonly<Record<string, unknown>>,
): SettingsIntake {
  const incoming = Object.create(null) as Record<string, unknown>;
  const accepted = Object.create(null) as Record<string, unknown>;
  const rejected: string[] = [];
  for (const name of PORTABLE_SETTING_NAMES) {
    const held = Object.prototype.hasOwnProperty.call(checkout, name);
    const checked = held ? normalizeSetting(name, checkout[name]) : null;
    if (checked?.ok) {
      incoming[name] = checked.value;
      accepted[name] = checked.value;
      continue;
    }
    if (held) rejected.push(name);
    if ((held || !isUnsettableSetting(name)) && local[name] !== undefined) {
      incoming[name] = local[name];
    }
  }
  return { incoming, accepted, rejected };
}

/** The environment as the column mirrors it, without the prompt-only fields of an older release. */
export const normalizeEnvironment = (environment: ProjectEnvironment): ProjectEnvironment => ({
  envDetectData: mirroredEnvDetectData(environment.envDetectData),
  confirmedValues: environment.confirmedValues,
});

/** The `onboarding_environment` column for an environment unit. */
export const environmentColumnOf = (
  environment: ProjectEnvironment,
): OnboardingEnvironmentMirror => ({
  schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  envDetectData: environment.envDetectData,
  confirmedValues: environment.confirmedValues,
});

/** The portable settings of a record that differ from what the file held, for the names not in
 *  `except`: the settings the writer has to bring the checkout's files to. */
export function settingsDifferingFrom(
  merged: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, unknown>>,
  except: ReadonlySet<string>,
): string[] {
  return PORTABLE_SETTING_NAMES.filter(
    (name) => !except.has(name) && !sameValue(merged[name], files[name]),
  );
}
