import type {
  ConflictSideBody,
  ProjectStateAnswer,
  ProjectStateConflictBody,
} from '@haive/shared/project-state';
import {
  CONFLICT_KEY_LABELS,
  RTK_ENABLED_UNIT,
  conflictUnitLabel,
} from '@haive/shared/project-state-conflicts';
import { fencedCode } from '../components/markdown/fenced-code';

export type { ProjectStateAnswer, ProjectStateConflictBody };

export const RECORD_FILE = '.haive-data/state/project/render.json';

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

export const isRtkConflict = (conflict: { unit: string }): boolean =>
  conflict.unit === RTK_ENABLED_UNIT;

export function conflictKeyLabel(key: string | null, unit?: string): string {
  if (unit !== undefined) return conflictUnitLabel(unit);
  if (key === null) return 'The whole project record file';
  return CONFLICT_KEY_LABELS[key] ?? key;
}

export function conflictSideMarkdown(side: ConflictSideBody, unit?: string): string {
  if (!side.present) return 'Not set.';
  if (unit === RTK_ENABLED_UNIT && typeof side.value === 'boolean')
    return side.value ? 'On' : 'Off';
  return fencedCode(JSON.stringify(side.value, null, 2) ?? 'null', 'json');
}

export function answerConfirmation(
  answer: ProjectStateAnswer,
  key: string | null,
  unit?: string,
): { title: string; body: string; confirmLabel: string } {
  const label = conflictKeyLabel(key, unit);
  if (unit === RTK_ENABLED_UNIT) {
    return answer === 'keep_mine'
      ? {
          title: "Keep this install's value",
          confirmLabel: 'Keep mine',
          body: `${label} stays on in this install. No repository file is written.`,
        }
      : {
          title: "Take the other install's value",
          confirmLabel: 'Take theirs',
          body: `${label} is switched off in this install, as the other install has it. This is the same as unticking it on the tooling page, and the next upgrade offers to remove its files. No repository file is written.`,
        };
  }
  if (answer === 'keep_mine') {
    return {
      title: "Keep this install's value",
      confirmLabel: 'Keep mine',
      body: `This install's value for ${label} is written into the project's record file, ${RECORD_FILE}. Commit and push that file so your teammate gets it. Until then the other install keeps asking.`,
    };
  }
  return {
    title: "Take the other install's value",
    confirmLabel: 'Take theirs',
    body: `This install switches to your teammate's value for ${label}. Its own value is dropped. No repository file is written.`,
  };
}

export function landedAnswer(resolution: string | null | undefined): ProjectStateAnswer | null {
  return resolution === 'keep_mine' || resolution === 'take_theirs' ? resolution : null;
}

export function resolutionNotice(
  answered: readonly ProjectStateAnswer[],
  rtkAnswered: readonly ProjectStateAnswer[] = [],
): string | null {
  const notices: string[] = [];
  if (answered.includes('keep_mine')) {
    notices.push(
      `This install's value is written into \`${RECORD_FILE}\`. Commit and push that file so your teammate gets it.`,
    );
  } else if (answered.includes('take_theirs')) {
    notices.push("This install now uses your teammate's value.");
  }
  if (rtkAnswered.includes('take_theirs')) {
    notices.push('RTK command compression is switched off in this install.');
  } else if (rtkAnswered.includes('keep_mine')) {
    notices.push('RTK command compression stays on in this install.');
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
