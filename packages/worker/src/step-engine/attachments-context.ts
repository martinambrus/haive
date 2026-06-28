import { asc, eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';

/** Prepend a compact "attached files" notice to a step's LLM prompt when the task
 *  has user-uploaded attachments. The prompt flows through the dispatcher to every
 *  CLI adapter unchanged, so this single call makes every agent (claude-code,
 *  codex, gemini, amp, ...) aware of the files without per-adapter changes. The
 *  files live at `<SANDBOX_WORKDIR>/.haive/task-uploads/<taskId>/` inside the
 *  sandbox (the repo root is mounted at SANDBOX_WORKDIR, so the agent reads them
 *  by absolute path regardless of its worktree cwd). Returns the prompt unchanged
 *  when the task has no attachments. */
export async function augmentPromptWithAttachments(
  db: Database,
  taskId: string,
  prompt: string,
): Promise<string> {
  const rows = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.taskId, taskId),
    orderBy: asc(schema.taskAttachments.createdAt),
    columns: { filename: true, description: true },
  });
  if (rows.length === 0) return prompt;

  const dir = `${SANDBOX_WORKDIR}/.haive/task-uploads/${taskId}`;
  const list = rows
    .map((r) => `  - ${r.filename}${r.description ? ` — ${r.description}` : ''}`)
    .join('\n');
  const notice = [
    '[User-attached files]',
    `The user attached ${rows.length} reference file(s) for this task, available read-only at:`,
    `  ${dir}/`,
    list,
    `See ${dir}/_ATTACHMENTS.md for descriptions. Read any that are relevant before proceeding.`,
    '',
    '',
  ].join('\n');
  return notice + prompt;
}
