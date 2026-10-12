import type {
  ConflictSideBody,
  ProjectStateAnswer,
  ProjectStateConflictBody,
} from '@haive/shared/project-state';
import { fencedCode } from '../components/markdown/fenced-code';

export type { ProjectStateAnswer, ProjectStateConflictBody };

export const RECORD_FILE = '.haive-data/state/project/render.json';

export const PENDING_REFETCH_MS = 3000;

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
