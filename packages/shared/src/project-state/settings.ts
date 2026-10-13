import { ONBOARDING_ENVIRONMENT_SCHEMA_VERSION } from '../types/index.js';
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
] as const;

/** The columns of a `repositories` row that hold a portable setting. */
export interface PortableSettingColumns {
  scopeExcludeGlobs: unknown;
  rtkEnabled: unknown;
  rtkVersion: unknown;
  lspServers: unknown;
  lspServerVersions: unknown;
  chromeDevtoolsMcpVersion: unknown;
  reviewDimensions: unknown;
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
  return settings;
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

/** The `settings/<name>.json` files of the record's settings, relative to the state directory. */
export const settingFileName = (name: string): string => `settings/${name}.json`;
