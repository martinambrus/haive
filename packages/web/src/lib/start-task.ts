import { startTask, type ApiError } from './api-client';

/** A declined confirmation leaves the draft available for repair in its Attachments tab. */
export async function startTaskWithAttachmentConfirmation(taskId: string) {
  try {
    return await startTask(taskId);
  } catch (error) {
    const err = error as ApiError;
    const counts = err.body as { landed?: unknown; expected?: unknown } | undefined;
    if (
      err.status !== 409 ||
      err.code !== 'task_attachments_missing' ||
      typeof counts?.landed !== 'number' ||
      typeof counts.expected !== 'number' ||
      !Number.isSafeInteger(counts.landed) ||
      !Number.isSafeInteger(counts.expected) ||
      counts.landed < 0 ||
      counts.expected <= counts.landed
    )
      throw error;
    if (
      !window.confirm(
        `${counts.expected - counts.landed} of ${counts.expected} attachments are missing. Start anyway?`,
      )
    )
      return null;
    return startTask(taskId, true);
  }
}
