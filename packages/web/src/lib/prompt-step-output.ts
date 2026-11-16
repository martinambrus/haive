import { isCustomStepId } from '@haive/shared/modularity';

/** The agent's reply of a finished prompt step, or null for any other step or an empty reply. */
export function promptStepReply(stepId: string, status: string, output: unknown): string | null {
  if (status !== 'done' || !isCustomStepId(stepId)) return null;
  const value = output as {
    raw?: unknown;
    roleOutput?: { contract?: unknown; data?: unknown };
  } | null;
  const raw = value?.raw;
  if (value?.roleOutput?.contract && value.roleOutput.data !== undefined)
    return JSON.stringify(
      { contract: value.roleOutput.contract, data: value.roleOutput.data },
      null,
      2,
    );
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}
