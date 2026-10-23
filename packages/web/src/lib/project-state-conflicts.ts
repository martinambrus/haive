import type {
  ConflictSideBody,
  ProjectStateAnswer,
  ProjectStateConflictBody,
} from '@haive/shared/project-state';
import {
  CONFLICT_KEY_LABELS,
  ENVIRONMENT_UNIT,
  RTK_ENABLED_UNIT,
  conflictUnitLabel,
  isClaimUnit,
  isEnvironmentUnit,
  isPlanUnit,
  isSettingUnit,
  parsePlanConflictUnit,
} from '@haive/shared/project-state-conflicts';
import { fencedCode } from '../components/markdown/fenced-code';

export type { ProjectStateAnswer, ProjectStateConflictBody };

export const RECORD_FILE = '.haive-data/state/project/render.json';

export const PLAN_FILE = '.haive-data/plan.json';

export function inlineCode(raw: string): string {
  const text = raw.replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

const STATE_DIR = '.haive-data/state';

/** The record file a question's answer writes: the unit's own, or the render file. */
export const recordFileOf = (unit?: string): string => {
  if (unit === undefined) return RECORD_FILE;
  if (isClaimUnit(unit) || isSettingUnit(unit)) return `${STATE_DIR}/${unit}`;
  return isEnvironmentUnit(unit) ? `${STATE_DIR}/${ENVIRONMENT_UNIT}` : RECORD_FILE;
};

export const PENDING_REFETCH_MS = 3000;

export const PENDING_REFETCH_LIMIT = 20;

export const PENDING_GAVE_UP_MESSAGE =
  'The answer is still being applied. Reload the page to check again.';

export function stillListed(
  ids: readonly string[],
  conflicts: ProjectStateConflictBody[],
): string[] {
  const listed = new Set(conflicts.map((c) => c.id));
  return ids.filter((id) => listed.has(id));
}

/** A question about one field of one plan node, answered on the plan page. */
export const isPlanConflict = (conflict: { unit: string }): boolean => isPlanUnit(conflict.unit);

const PLAN_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: 'Title',
  body: 'Text',
  kind: 'Kind',
  status: 'Status',
  taskable: 'Can start tasks',
};

/** What a plan question is about, as markdown: the node's title as code, then the field. */
export function planConflictHeading(conflict: { unit: string; nodeTitle?: string | null }): string {
  const field = parsePlanConflictUnit(conflict.unit)?.field ?? '';
  const node =
    conflict.nodeTitle == null ? 'A node that was deleted here' : inlineCode(conflict.nodeTitle);
  return `${node}: ${PLAN_FIELD_LABELS[field] ?? field}`;
}

function planSideMarkdown(field: string, value: unknown): string {
  if (field === 'body') return typeof value === 'string' && value !== '' ? value : 'No text.';
  if (field === 'taskable') return value === true ? 'Yes' : value === false ? 'No' : 'Not set.';
  if (typeof value === 'string') return inlineCode(value);
  return fencedCode(JSON.stringify(value, null, 2) ?? 'null', 'json');
}

export const isRtkConflict = (conflict: { unit: string }): boolean =>
  conflict.unit === RTK_ENABLED_UNIT;

export const isClaimConflict = (conflict: { unit: string }): boolean => isClaimUnit(conflict.unit);

/** A setting or the environment, RTK's question aside: answered like a render key, into its own file. */
export const isSettingConflict = (conflict: { unit: string }): boolean =>
  !isRtkConflict(conflict) && (isSettingUnit(conflict.unit) || isEnvironmentUnit(conflict.unit));

/** The file a claim question is about: a claim unit names its file only through the claim its sides hold. */
export function conflictClaimPath(
  conflict: Pick<ProjectStateConflictBody, 'unit' | 'base' | 'local' | 'incoming'>,
): string | null {
  if (!isClaimUnit(conflict.unit)) return null;
  for (const side of [conflict.local, conflict.incoming, conflict.base]) {
    const path = side.present ? (side.value as { path?: unknown } | null)?.path : undefined;
    if (typeof path === 'string') return path;
  }
  return null;
}

export function conflictKeyLabel(
  key: string | null,
  unit?: string,
  claimPath?: string | null,
): string {
  if (unit !== undefined) return conflictUnitLabel(unit, claimPath);
  if (key === null) return 'The whole project record file';
  return CONFLICT_KEY_LABELS[key] ?? key;
}

const bulletList = (items: readonly string[]): string =>
  items.length === 0 ? 'Empty.' : items.map((item) => `- ${item}`).join('\n');

/** A setting's value as a person reads it, rather than as the JSON the record file holds. */
function settingMarkdown(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return inlineCode(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return bulletList(value.map(inlineCode));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.every(([, v]) => typeof v === 'string')) {
      return bulletList(entries.map(([k, v]) => `${inlineCode(k)}: ${inlineCode(String(v))}`));
    }
  }
  return null;
}

export function conflictSideMarkdown(side: ConflictSideBody, unit?: string): string {
  if (!side.present) return 'Not set.';
  const plan = unit === undefined ? null : parsePlanConflictUnit(unit);
  if (plan) return planSideMarkdown(plan.field, side.value);
  if (unit !== undefined && isSettingUnit(unit)) {
    const text = settingMarkdown(side.value);
    if (text !== null) return text;
  }
  if (unit !== undefined && isClaimUnit(unit)) {
    const claim = side.value as Record<string, unknown> | null;
    if (claim !== null && typeof claim === 'object' && typeof claim.templateId === 'string') {
      const version = typeof claim.haiveVersion === 'string' && claim.haiveVersion !== '';
      return [
        `- Template: ${inlineCode(claim.templateId)}`,
        `- Kind: ${inlineCode(String(claim.kind))}`,
        `- Haive version: ${version ? inlineCode(String(claim.haiveVersion)) : 'not recorded'}`,
        `- Written hash: ${inlineCode(String(claim.writtenHash).slice(0, 12))}`,
      ].join('\n');
    }
  }
  return fencedCode(JSON.stringify(side.value, null, 2) ?? 'null', 'json');
}

export function answerConfirmation(
  answer: ProjectStateAnswer,
  key: string | null,
  unit?: string,
  claimPath?: string | null,
): { title: string; body: string; confirmLabel: string } {
  const label = conflictKeyLabel(key, unit, claimPath);
  if (unit !== undefined && isPlanUnit(unit)) {
    return answer === 'keep_mine'
      ? {
          title: "Keep this install's value",
          confirmLabel: 'Keep mine',
          body: `This plan keeps its own value, and \`${PLAN_FILE}\` is rewritten with it. Commit and push that file so your teammate gets it. Until then the other install keeps asking.`,
        }
      : {
          title: "Take the other install's value",
          confirmLabel: 'Take theirs',
          body: `This plan switches to your teammate's value, and \`${PLAN_FILE}\` is rewritten with it. This install's own value is dropped.`,
        };
  }
  if (unit === RTK_ENABLED_UNIT) {
    return answer === 'keep_mine'
      ? {
          title: "Keep this install's value",
          confirmLabel: 'Keep mine',
          body: `${label} stays on in this install. This install's choice is recorded in the project's record file, ${recordFileOf(unit)}. Commit and push that file if it changed, so your teammate gets it.`,
        }
      : {
          title: "Take the other install's value",
          confirmLabel: 'Take theirs',
          body: `${label} is switched off in this install, as the other install has it. This is the same as unticking it on the tooling page, and the next upgrade offers to remove its files. This install's choice is recorded in the project's record file, ${recordFileOf(unit)}. Commit and push that file if it changed, so your teammate gets it.`,
        };
  }
  if (answer === 'keep_mine') {
    return {
      title: "Keep this install's value",
      confirmLabel: 'Keep mine',
      body: `This install's value for ${label} is written into the project's record file, ${recordFileOf(unit)}. Commit and push that file so your teammate gets it. Until then the other install keeps asking.`,
    };
  }
  return {
    title: "Take the other install's value",
    confirmLabel: 'Take theirs',
    body: `This install switches to your teammate's value for ${label}. This install's own value is dropped. No repository file is written.`,
  };
}

export function landedAnswer(resolution: string | null | undefined): ProjectStateAnswer | null {
  return resolution === 'keep_mine' || resolution === 'take_theirs' ? resolution : null;
}

export function resolutionNotice(
  answered: readonly ProjectStateAnswer[],
  rtkAnswered: readonly ProjectStateAnswer[] = [],
  claimAnswered: readonly ProjectStateAnswer[] = [],
  settingAnswered: readonly ProjectStateAnswer[] = [],
  planAnswered: readonly ProjectStateAnswer[] = [],
): string | null {
  const notices: string[] = [];
  if (planAnswered.includes('keep_mine')) {
    notices.push(
      `This plan keeps its own value and \`${PLAN_FILE}\` is rewritten with it. Commit and push that file so your teammate gets it.`,
    );
  } else if (planAnswered.includes('take_theirs')) {
    notices.push("This plan now uses your teammate's value.");
  }
  if (settingAnswered.includes('keep_mine')) {
    notices.push(
      "This install's value is written into the project's record. Commit and push the changed file so your teammate gets it.",
    );
  } else if (settingAnswered.includes('take_theirs')) {
    notices.push("This install now uses your teammate's value.");
  }
  if (answered.includes('keep_mine')) {
    notices.push(
      `This install's value is written into \`${RECORD_FILE}\`. Commit and push that file so your teammate gets it.`,
    );
  } else if (answered.includes('take_theirs')) {
    notices.push("This install now uses your teammate's value.");
  }
  if (claimAnswered.includes('keep_mine')) {
    notices.push(
      "This install's record of the file is written into the project's record. Commit and push it so your teammate gets it.",
    );
  } else if (claimAnswered.includes('take_theirs')) {
    notices.push("This install now records the file as your teammate's install does.");
  }
  if (rtkAnswered.includes('take_theirs')) {
    notices.push('RTK command compression is switched off in this install.');
  } else if (rtkAnswered.includes('keep_mine')) {
    notices.push('RTK command compression stays on in this install.');
  }
  if (rtkAnswered.length > 0) {
    notices.push(
      `This install's choice is recorded in \`${recordFileOf(RTK_ENABLED_UNIT)}\`. Commit and push that file if it changed, so your teammate gets it.`,
    );
  }
  return notices.length > 0 ? notices.join(' ') : null;
}

export type ConflictAnswerOutcome =
  | { kind: 'resolved' }
  | { kind: 'pending'; message: string }
  | {
      kind: 'error';
      message: string;
      ambiguous: boolean;
      code?: string;
      /** The answer the row was closed with, when it was already settled by another request. */
      landed?: ProjectStateAnswer;
    };

const SETTLED_CODE = 'project_state_conflict_settled';

export const UNCONFIRMED_MESSAGE =
  'The answer could not be confirmed yet. Checking again before anything else is offered.';

export async function submitConflictAnswer(
  post: <T>(path: string, body?: unknown) => Promise<T>,
  repositoryId: string,
  conflictId: string,
  answer: ProjectStateAnswer,
): Promise<ConflictAnswerOutcome> {
  try {
    const res = await post<{ pending?: boolean; message?: string }>(
      `/repos/${repositoryId}/project-state/conflicts/${conflictId}`,
      { answer },
    );
    if (res.pending === true) {
      return { kind: 'pending', message: res.message ?? 'The answer is still being applied.' };
    }
    return { kind: 'resolved' };
  } catch (err) {
    const { status, code } = err as { status?: unknown; code?: unknown };
    return {
      kind: 'error',
      message: (err as Error).message || 'Could not send the answer.',
      ambiguous: typeof status !== 'number' || status >= 500,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
}

/** Sends the answer. A refusal (4xx) stands. A failure that leaves it unknown whether the answer
 *  landed (network, 5xx), or a refusal saying the row was already settled, asks the row: closed with
 *  this answer is resolved, closed with the other carries it as `landed` so its notice is shown,
 *  and still open or unreadable stays pending for the poll to settle. */
export async function answerAndConfirm(
  post: <T>(path: string, body?: unknown) => Promise<T>,
  get: <T>(path: string) => Promise<T>,
  repositoryId: string,
  conflictId: string,
  answer: ProjectStateAnswer,
): Promise<ConflictAnswerOutcome> {
  const outcome = await submitConflictAnswer(post, repositoryId, conflictId, answer);
  if (outcome.kind !== 'error') return outcome;
  if (!outcome.ambiguous && outcome.code !== SETTLED_CODE) return outcome;
  const row = await get<{ conflict: ProjectStateConflictBody }>(
    `/repos/${repositoryId}/project-state/conflicts/${conflictId}`,
  ).then(
    (res) => res.conflict,
    () => null,
  );
  if (row === null || row.resolution === null) {
    return { kind: 'pending', message: UNCONFIRMED_MESSAGE };
  }
  const landed = landedAnswer(row.resolution);
  if (landed === answer) return { kind: 'resolved' };
  return landed ? { ...outcome, landed } : outcome;
}
