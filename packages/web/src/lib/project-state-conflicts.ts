import type {
  ConflictSideBody,
  ProjectStateAnswer,
  ProjectStateConflictBody,
} from '@haive/shared/project-state';
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

const KEY_LABELS: Record<string, string> = {
  projectInfo: 'Project details',
  framework: 'Framework',
  acceptedAgentIds: 'Accepted agents',
  customAgentSpecs: 'Custom agents',
};

export function conflictKeyLabel(key: string | null): string {
  if (key === null) return 'The whole project record file';
  return KEY_LABELS[key] ?? key;
}

export function conflictSideMarkdown(side: ConflictSideBody): string {
  if (!side.present) return 'Not set.';
  return fencedCode(JSON.stringify(side.value, null, 2) ?? 'null', 'json');
}

export function answerConfirmation(
  answer: ProjectStateAnswer,
  key: string | null,
): { title: string; body: string; confirmLabel: string } {
  const label = conflictKeyLabel(key);
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

export function resolutionNotice(answered: readonly ProjectStateAnswer[]): string | null {
  if (answered.includes('keep_mine')) {
    return `This install's value is written into \`${RECORD_FILE}\`. Commit and push that file so your teammate gets it.`;
  }
  if (answered.includes('take_theirs')) return "This install now uses your teammate's value.";
  return null;
}

export type ConflictAnswerOutcome =
  { kind: 'resolved' } | { kind: 'pending'; message: string } | { kind: 'error'; message: string };

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
    return { kind: 'error', message: (err as Error).message || 'Could not send the answer.' };
  }
}
