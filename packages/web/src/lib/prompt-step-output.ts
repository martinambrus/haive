import { isCustomStepId } from '@haive/shared/modularity';

/** The agent's reply of a finished prompt step, or null for any other step or an empty reply. */
export function promptStepReply(stepId: string, status: string, output: unknown): string | null {
  if (status !== 'done' || !isCustomStepId(stepId)) return null;
  const raw = (output as { raw?: unknown } | null)?.raw;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}
