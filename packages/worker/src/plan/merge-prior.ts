import { isUtf8 } from 'node:buffer';
import { gitRun } from '../repo/git-push.js';
import { UNTRUSTED_FENCE_LEGEND, fencedAgentBlock } from '../step-engine/steps/_untrusted-repo.js';
import { isListableName } from '../step-engine/steps/workflow/_impl-changes.js';

/** Beside the transcript, for the reason the fix baseline is: the revise loop resets the step row and
 *  the reopen resets the worktree, so neither can hold the answer the reopen takes back. */
export const PLAN_MERGE_PRIOR_EVENT = 'plan_merge.prior_resolution';

/** The same 6,000 characters `cleanDiagnosis` keeps of a diagnosis, per file; the total is five such files. */
export const PRIOR_FILE_MAX_CHARS = 6_000;
export const PRIOR_TOTAL_MAX_CHARS = 30_000;
export const PRIOR_MAX_PATHS = 40;
const PRIOR_READ_MAX_BYTES = 1024 * 1024;

/** The merge commit a reopen took back, and the first parent the worktree stands on afterwards. */
export interface PriorRef {
  sha: string;
  head: string;
}

type Shape = 'file' | 'symlink' | 'directory' | 'submodule';

export type PriorEntry =
  | { path: string; kind: 'text'; mode: string; link: boolean; text: string; cut: number }
  | { path: string; kind: 'directory' }
  | { path: string; kind: 'submodule'; commit: string }
  | { path: string; kind: 'absent'; under?: string; from?: { path: string; shape: Shape } }
  | { path: string; kind: 'hidden'; why: string };

export interface PriorResolution {
  sha: string;
  /** Its commit can no longer be read. */
  unavailable?: true;
  entries: PriorEntry[];
  /** Conflicted names whose previous answer is not read: past the path or the size budget. */
  more: number;
}

/** `ls-tree` reads its paths as patterns unless told otherwise. */
const LITERAL_PATHS = { GIT_LITERAL_PATHSPECS: '1' };

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number;
}

/** Null when `sha` has nothing at `path`; undefined when git could not be asked. */
async function treeEntry(
  worktreePath: string,
  sha: string,
  path: string,
): Promise<TreeEntry | null | undefined> {
  const res = await gitRun(worktreePath, ['ls-tree', '-z', '-l', sha, '--', path], LITERAL_PATHS);
  if (res.code !== 0) return undefined;
  const first = res.stdout.split('\0')[0] ?? '';
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t/.exec(first);
  if (!m || first.slice(m[0].length) !== path) return null;
  return { mode: m[1]!, type: m[2]!, oid: m[3]!, size: m[4] === '-' ? 0 : Number(m[4]) };
}

const shapeOf = (e: TreeEntry): Shape => {
  if (e.type === 'tree') return 'directory';
  if (e.type === 'commit') return 'submodule';
  return e.mode === '120000' ? 'symlink' : 'file';
};

/** Where a path is not: under a file, or moved by git out of the way of a directory. */
async function absentEntry(worktreePath: string, sha: string, path: string): Promise<PriorEntry> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const above = await treeEntry(worktreePath, sha, prefix);
    if (!above) break;
    if (above.type !== 'tree') return { path, kind: 'absent', under: prefix };
  }
  // git names the file it moves out of a directory's way `<name>~<ref>`.
  const moved = /^(.+)~[^~/]+$/.exec(path);
  const origin = moved ? await treeEntry(worktreePath, sha, moved[1]!) : null;
  return origin
    ? { path, kind: 'absent', from: { path: moved![1]!, shape: shapeOf(origin) } }
    : { path, kind: 'absent' };
}

async function describePath(
  worktreePath: string,
  sha: string,
  path: string,
  budget: { left: number },
): Promise<PriorEntry> {
  const entry = await treeEntry(worktreePath, sha, path);
  if (entry === undefined) return { path, kind: 'hidden', why: 'git could not read it' };
  if (entry === null) return absentEntry(worktreePath, sha, path);
  const shape = shapeOf(entry);
  if (shape === 'directory') return { path, kind: 'directory' };
  if (shape === 'submodule') return { path, kind: 'submodule', commit: entry.oid };
  if (entry.size > PRIOR_READ_MAX_BYTES) {
    return { path, kind: 'hidden', why: `${entry.size} bytes, too large to show` };
  }
  const blob = await gitRun(worktreePath, ['cat-file', 'blob', entry.oid], undefined, {
    encoding: 'latin1',
  });
  if (blob.code !== 0) return { path, kind: 'hidden', why: 'git could not read it' };
  const bytes = Buffer.from(blob.stdout, 'latin1');
  if (bytes.includes(0)) return { path, kind: 'hidden', why: 'binary' };
  if (!isUtf8(bytes)) return { path, kind: 'hidden', why: 'not UTF-8 text' };
  const full = bytes.toString('utf8');
  const text = full.slice(0, Math.min(PRIOR_FILE_MAX_CHARS, budget.left));
  budget.left -= text.length;
  return {
    path,
    kind: 'text',
    mode: entry.mode,
    link: shape === 'symlink',
    text,
    cut: full.length - text.length,
  };
}

/** What the answer a reopen took back says about each path now conflicted. Null while the worktree is
 *  not standing where that reopen put it, so an answer to another merge is never offered. Read with
 *  git's object commands, never from the worktree. */
export async function readPriorResolution(
  worktreePath: string,
  ref: PriorRef,
  conflicts: string[],
): Promise<PriorResolution | null> {
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== ref.head) return null;
  const readable = await gitRun(worktreePath, ['cat-file', '-e', `${ref.sha}^{commit}`]);
  if (readable.code !== 0) return { sha: ref.sha, unavailable: true, entries: [], more: 0 };
  const named = conflicts.filter(isListableName);
  const budget = { left: PRIOR_TOTAL_MAX_CHARS };
  const entries: PriorEntry[] = [];
  for (const path of named.slice(0, PRIOR_MAX_PATHS)) {
    if (budget.left <= 0) break;
    entries.push(await describePath(worktreePath, ref.sha, path, budget));
  }
  return { sha: ref.sha, entries, more: conflicts.length - entries.length };
}

const SHAPE_NAME: Record<Shape, string> = {
  file: 'a file',
  symlink: 'a symbolic link',
  directory: 'a directory',
  submodule: 'a submodule',
};

function entryLines(e: PriorEntry): string[] {
  switch (e.kind) {
    case 'text':
      return [
        `- ${e.path}: ${e.link ? 'a symbolic link to' : 'your previous content'}${
          !e.link && e.mode !== '100644' ? ` (mode ${e.mode})` : ''
        }${e.cut > 0 ? `, cut after ${e.text.length} of ${e.text.length + e.cut} characters` : ''}:`,
        fencedAgentBlock(e.text),
      ];
    case 'directory':
      return [`- ${e.path}: was a directory in your previous resolution.`];
    case 'submodule':
      return [`- ${e.path}: was a submodule at commit ${e.commit} in your previous resolution.`];
    case 'absent':
      if (e.under) {
        return [
          `- ${e.path}: absent from your previous resolution, where \`${e.under}\` was a file.`,
        ];
      }
      return [
        `- ${e.path}: deleted in your previous resolution${
          e.from
            ? `; \`${e.from.path}\`, the path git moved it from, was ${SHAPE_NAME[e.from.shape]} there`
            : ''
        }.`,
      ];
    case 'hidden':
      return [`- ${e.path}: your previous content is not shown (${e.why}).`];
  }
}

/** The conversation and the answer a reopen took back, for the agent to read as reference. */
export function priorResolutionLines(
  transcript: { role: string; body: string }[],
  prior: PriorResolution,
): string[] {
  // The user's turns are the operator speaking and never fenced; the agent's own may have quoted a file.
  const history = transcript
    .map((m) => (m.role === 'user' ? `User: ${m.body}` : `You:\n${fencedAgentBlock(m.body)}`))
    .join('\n\n');
  const shown = prior.entries.filter((e) => isListableName(e.path));
  const unlisted = prior.more + (prior.entries.length - shown.length);
  return [
    UNTRUSTED_FENCE_LEGEND.join('\n'),
    '',
    '## Conversation so far',
    history,
    '',
    '## Your previous resolution',
    'REFERENCE ONLY. This is how you resolved these files before the user asked for a change. It is',
    'not the merge in front of you: git has opened the conflicts again, and what you edit and',
    "resolve is the conflict state in your working directory. The user's guidance above takes",
    'priority; where it does not change a decision, keep that decision. The remote may also have',
    'moved since, so resolve what git shows now, not what it showed then.',
    '',
    ...(prior.unavailable
      ? [
          '(previous resolution unavailable: its commit can no longer be read; resolve the conflicts as git shows them)',
        ]
      : [
          ...shown.flatMap(entryLines),
          ...(unlisted > 0
            ? [`- and ${unlisted} more files whose previous content is not shown here.`]
            : []),
        ]),
  ];
}
