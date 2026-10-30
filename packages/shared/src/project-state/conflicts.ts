import { sameValue } from './canonical.js';
import { settingNameOfFile } from './raw-text.js';
import { isPortableSettingName, type PortableSettingName } from './settings.js';
import { PLAN_MIRROR_ASKED_FIELDS } from '../plan/merge-mirror.js';

/** The unit of the whole render file; a key of it is `<RENDER_UNIT>#<key>`. */
export const RENDER_UNIT = 'project/render.json';

export const isRenderUnit = (unit: string): boolean =>
  unit === RENDER_UNIT || unit.startsWith(`${RENDER_UNIT}#`);

/** The unit of the question about an imported RTK-off this install never applied; the file does not
 *  exist, it only names the setting. */
export const RTK_ENABLED_UNIT = 'settings/rtk-enabled.json';

/** The unit of one artifact claim: `claimFileName(path)`, the claim's file in the record. */
export const isClaimUnit = (unit: string): boolean =>
  /^artifacts\/[^/]+~[0-9a-f]{32}\.json$/.test(unit);

/** The unit of the whole environment file; a key of it is `<ENVIRONMENT_UNIT>#<key>`. */
export const ENVIRONMENT_UNIT = 'project/environment.json';

export const isEnvironmentUnit = (unit: string): boolean =>
  unit === ENVIRONMENT_UNIT || unit.startsWith(`${ENVIRONMENT_UNIT}#`);

/** The unit of one portable setting: its file in the record. */
export const isSettingUnit = (unit: string): boolean => {
  const name = settingNameOfFile(unit);
  return name !== null && isPortableSettingName(name);
};

/** The unit of one plan question: a field of one node, `plan/<nodeId>#<field>`. */
export const PLAN_UNIT_PREFIX = 'plan/';

export const planConflictUnit = (nodeId: string, field: string): string =>
  `${PLAN_UNIT_PREFIX}${nodeId}#${field}`;

export const parsePlanConflictUnit = (unit: string): { nodeId: string; field: string } | null => {
  if (!unit.startsWith(PLAN_UNIT_PREFIX)) return null;
  const rest = unit.slice(PLAN_UNIT_PREFIX.length);
  const hash = rest.indexOf('#');
  if (hash <= 0 || hash === rest.length - 1) return null;
  return { nodeId: rest.slice(0, hash), field: rest.slice(hash + 1) };
};

export const isPlanUnit = (unit: string): boolean => {
  const parsed = parsePlanConflictUnit(unit);
  return parsed !== null && (PLAN_MIRROR_ASKED_FIELDS as readonly string[]).includes(parsed.field);
};

export const isConflictUnit = (unit: string): boolean =>
  isPlanUnit(unit) ||
  isRenderUnit(unit) ||
  isClaimUnit(unit) ||
  isSettingUnit(unit) ||
  isEnvironmentUnit(unit) ||
  unit === RTK_ENABLED_UNIT;

/** Whether an unanswered question about the unit holds upgrades and rollbacks. Of the settings and
 *  the environment only RTK does: its off state takes files out of the next upgrade. A plan question
 *  never does. */
export const blocksUpgrade = (unit: string): boolean =>
  isConflictUnit(unit) &&
  !isPlanUnit(unit) &&
  (unit === RTK_ENABLED_UNIT || !(isSettingUnit(unit) || isEnvironmentUnit(unit)));

/** The row of the RTK question about an imported RTK-off, whose base is what this install holds. A
 *  sync never converges it: no merge contests that unit, so nothing it finds would be this question. */
export const isRtkQuestion = (row: { unit: string; base: unknown; local: unknown }): boolean =>
  row.unit === RTK_ENABLED_UNIT && sameValue(row.base, row.local);

/** A conflict side as the `project_state_conflicts` columns hold it: `{ v }`, so a JSON null is a
 *  value, and NULL for a side that has no such unit. */
const SETTING_LABELS = {
  'scope-exclude-globs': 'Paths left out of the project scope',
  'rtk-enabled': 'RTK command compression',
  'rtk-version': 'RTK version',
  'lsp-servers': 'Language servers',
  'lsp-server-versions': 'Language server versions',
  'chrome-devtools-mcp-version': 'Chrome DevTools MCP version',
  'review-dimensions': 'Review dimensions',
  'agent-rules': 'AGENTS.md rules',
} as const satisfies Record<PortableSettingName, string>;

const ENVIRONMENT_KEY_LABELS: Readonly<Record<string, string>> = {
  envDetectData: 'Detected environment',
  confirmedValues: 'Confirmed environment values',
};

export const CONFLICT_KEY_LABELS: Readonly<Record<string, string>> = {
  projectInfo: 'Project details',
  framework: 'Framework',
  acceptedAgentIds: 'Accepted agents',
  customAgentSpecs: 'Custom agents',
};

/** What a person calls the setting a conflict unit holds, rather than its storage path. A claim
 *  unit names no path itself, so `claimPath` (read from a side) says which file it is about. */
export function conflictUnitLabel(unit: string, claimPath?: string | null): string {
  const plan = parsePlanConflictUnit(unit);
  if (plan && isPlanUnit(unit)) return `Plan: ${plan.field} of a node`;
  if (isSettingUnit(unit)) return SETTING_LABELS[settingNameOfFile(unit) as PortableSettingName];
  if (unit === ENVIRONMENT_UNIT) return 'The project environment';
  if (unit.startsWith(`${ENVIRONMENT_UNIT}#`)) {
    const key = unit.slice(ENVIRONMENT_UNIT.length + 1);
    return ENVIRONMENT_KEY_LABELS[key] ?? key;
  }
  if (isClaimUnit(unit)) return `the claim for ${claimPath ?? 'a generated file'}`;
  if (unit === RENDER_UNIT) return 'The whole project record file';
  const key = unit.startsWith(`${RENDER_UNIT}#`) ? unit.slice(RENDER_UNIT.length + 1) : unit;
  return CONFLICT_KEY_LABELS[key] ?? key;
}

export const conflictSide = (value: unknown): { v: unknown } | null =>
  value === undefined ? null : { v: value };

export const conflictSideValue = (side: unknown): unknown =>
  side === null || side === undefined ? undefined : (side as { v: unknown }).v;

export const PROJECT_STATE_ANSWERS = ['keep_mine', 'take_theirs'] as const;
export type ProjectStateAnswer = (typeof PROJECT_STATE_ANSWERS)[number];

export type ConflictSideBody = { present: false } | { present: true; value: unknown };

/** A conflict row as the api serves it: a side is its value, or marked absent where this unit has none. */
export interface ProjectStateConflictBody {
  id: string;
  unit: string;
  /** The render key the unit names; null for the whole file. */
  key: string | null;
  base: ConflictSideBody;
  local: ConflictSideBody;
  incoming: ConflictSideBody;
  detectedAt: string;
  resolution: string | null;
  resolvedAt: string | null;
  /** A plan question only: the node's current title, null once the node is gone. */
  nodeTitle?: string | null;
}

const sideBody = (side: unknown): ConflictSideBody =>
  side === null || side === undefined
    ? { present: false }
    : { present: true, value: (side as { v: unknown }).v };

export function conflictBody(row: {
  id: string;
  unit: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
  detectedAt: Date;
  resolution: string | null;
  resolvedAt: Date | null;
}): ProjectStateConflictBody {
  return {
    id: row.id,
    unit: row.unit,
    key:
      row.unit.includes('#') && !isClaimUnit(row.unit)
        ? row.unit.slice(row.unit.indexOf('#') + 1)
        : null,
    base: sideBody(row.base),
    local: sideBody(row.local),
    incoming: sideBody(row.incoming),
    detectedAt: row.detectedAt.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

export interface ProjectStateResolvePayload {
  repositoryId: string;
  userId: string;
  conflictId: string;
  answer: ProjectStateAnswer;
}

/** `settled` is a row already closed by a different answer, or by the two installs agreeing. */
export type ProjectStateResolveResult =
  | { kind: 'resolved'; conflict: ProjectStateConflictBody; written: string[] }
  | { kind: 'not_found' }
  | { kind: 'settled'; resolution: string }
  | { kind: 'busy' }
  | { kind: 'moved' }
  | { kind: 'no_local' }
  | { kind: 'invalid' };
