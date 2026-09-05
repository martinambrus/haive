import { asc, eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { logger, splitAttachmentPath } from '@haive/shared';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';

const log = logger.child({ module: 'attachments-context' });

/** Files the prompt names one by one before it collapses to folder counts. */
const ATTACHMENT_PROMPT_FILE_LIMIT = 40;

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
  let rows: Array<{ filename: string; description: string | null }>;
  try {
    rows = await db.query.taskAttachments.findMany({
      where: eq(schema.taskAttachments.taskId, taskId),
      orderBy: asc(schema.taskAttachments.createdAt),
      columns: { filename: true, description: true },
    });
  } catch (err) {
    // Attachments are optional context — never fail a step because the lookup
    // failed (transient DB error, etc.). Degrade to the unchanged prompt.
    log.warn({ err, taskId }, 'failed to load task attachments for prompt context');
    return prompt;
  }
  if (rows.length === 0) return prompt;

  const dir = `${SANDBOX_WORKDIR}/.haive/task-uploads/${taskId}`;
  const { lines, named } = describeAttachments(rows);
  const notice = [
    '[User-attached files]',
    `The user attached ${rows.length} reference file(s) for this task, available read-only at:`,
    `  ${dir}/`,
    ...lines,
    ...(named < rows.length
      ? [
          `COVERAGE: the list above names ${named} of ${rows.length} attached files; the rest are`,
          `inside the folders listed. ${dir}/_ATTACHMENTS.md indexes every one of them by path.`,
        ]
      : []),
    `See ${dir}/_ATTACHMENTS.md for descriptions. Read any that are relevant before proceeding.`,
    '',
    '',
  ].join('\n');
  return notice + prompt;
}

/**
 * The file list, and how many files it actually NAMES.
 *
 * This notice rides EVERY step's prompt, so it is the one place a folder upload
 * turns into unbounded cost: 400 attachments used to be 400 lines in front of
 * every agent, on every step, for the life of the task. Past the limit the list
 * collapses to one line per top-level folder with a count, and the caller states
 * the elision — an agent told nothing would read a short list as the whole set.
 *
 * Under the limit the output is byte-identical to what it always was, which is
 * what keeps the common case (a handful of files) unchanged.
 */
function describeAttachments(rows: readonly { filename: string; description: string | null }[]): {
  lines: string[];
  named: number;
} {
  const line = (r: { filename: string; description: string | null }): string =>
    `  - ${r.filename}${r.description ? ` — ${r.description}` : ''}`;
  if (rows.length <= ATTACHMENT_PROMPT_FILE_LIMIT) {
    return { lines: rows.map(line), named: rows.length };
  }

  const loose: typeof rows = rows.filter((r) => splitAttachmentPath(r.filename).dir === '');
  const folders = new Map<string, number>();
  for (const row of rows) {
    const { dir } = splitAttachmentPath(row.filename);
    if (dir === '') continue;
    const top = dir.split('/')[0] ?? dir;
    folders.set(top, (folders.get(top) ?? 0) + 1);
  }

  const shownLoose = loose.slice(0, ATTACHMENT_PROMPT_FILE_LIMIT);
  return {
    lines: [
      ...shownLoose.map(line),
      ...[...folders.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `  - ${name}/ — ${count} file(s)`),
    ],
    named: shownLoose.length,
  };
}
