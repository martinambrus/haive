import { isUtf8 } from 'node:buffer';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { PROJECT_STATE_DIR } from '@haive/shared/project-state';
import { GIT_MAX_BUFFER, gitGaveNoAnswer, gitRun } from '../repo/git-exec.js';
import { provesUnbornHead } from '../repo/unborn-head.js';
import { gitBlobSizes, readGitBlobs } from '../repo/git-blobs.js';

const projectionPaths = [PROJECT_STATE_DIR, HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown];
export interface ProjectionEntries {
  index: Map<string, string>;
  staged: Map<string, string | 'unmerged'>;
  head: Map<string, string>;
  sizes: Map<string, number>;
}

/** Read each projection listing once per observation. Scope by the three fixed projection roots,
 * rather than an argv per dirty path (which can exceed ARG_MAX). Names are NUL delimited. */
export async function projectionEntries(repoPath: string): Promise<ProjectionEntries> {
  const index = await gitRun(
    repoPath,
    ['--no-optional-locks', 'ls-files', '-s', '-z', '--', ...projectionPaths],
    undefined,
    { encoding: 'latin1' },
  );
  if (index.code !== 0)
    throw new Error(`git ls-files failed: ${index.stderr.trim().slice(0, 300)}`);
  const tree = await gitRun(
    repoPath,
    ['ls-tree', '-r', '-l', '-z', 'HEAD', '--', ...projectionPaths],
    undefined,
    { encoding: 'latin1' },
  );
  if (tree.code !== 0 && (gitGaveNoAnswer(tree) || !(await provesUnbornHead(repoPath))))
    throw new Error('projection HEAD entries could not be read');
  const out: ProjectionEntries = {
    index: new Map(),
    staged: new Map(),
    head: new Map(),
    sizes: new Map(),
  };
  for (const entry of index.stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(entry);
    if (!m) continue;
    const mode = m[1]!,
      oid = m[2]!,
      stage = m[3]!,
      raw = m[4]!;
    const bytes = Buffer.from(raw, 'latin1');
    if (!isUtf8(bytes)) continue;
    const path = bytes.toString('utf8');
    if (stage !== '0') out.staged.set(path, 'unmerged');
    else {
      out.index.set(path, `${mode} ${oid}`);
      if (out.staged.get(path) !== 'unmerged') out.staged.set(path, oid);
    }
  }
  for (const entry of tree.stdout.split('\0')) {
    const m = /^(\d+) blob ([0-9a-f]+) +(\d+)\t([\s\S]*)$/.exec(entry);
    if (!m) continue;
    const bytes = Buffer.from(m[4]!, 'latin1');
    if (!isUtf8(bytes)) continue;
    out.head.set(bytes.toString('utf8'), `${m[1]} ${m[2]}`);
    out.sizes.set(m[2]!, Number(m[3]));
  }
  return out;
}

export const entryOid = (entry: string | undefined): string | null => entry?.split(' ')[1] ?? null;

/** Only read staged blobs that differ from HEAD and fit their path's bound. The caller refuses
 * missing/oversized blobs as before; no content can grow an individual or aggregate allocation. */
export async function stagedProjectionBlobs(
  repoPath: string,
  paths: readonly string[],
  entries: ProjectionEntries,
  cap: (path: string) => number,
  totalCap: number,
): Promise<Map<string, Buffer>> {
  const candidates = paths.flatMap((path) => {
    const oid = entries.staged.get(path);
    return oid !== undefined && oid !== 'unmerged' && oid !== entryOid(entries.head.get(path))
      ? [{ oid, path }]
      : [];
  });
  const sizes = await gitBlobSizes(
    repoPath,
    candidates.map((c) => c.oid),
  );
  return readGitBlobs(
    repoPath,
    candidates.flatMap(({ oid, path }) => {
      const size = sizes.get(oid)!;
      return size <= cap(path) ? [{ oid, size }] : [];
    }),
    totalCap,
  );
}

export async function projectionModeChanges(
  repoPath: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const changed = new Map<string, string>();
  if (paths.length === 0) return changed;
  const wanted = new Set(paths);
  for (const side of ['index', 'tree'] as const) {
    const res = await gitRun(repoPath, [
      '--no-optional-locks',
      'diff-index',
      '--raw',
      '-z',
      '--no-renames',
      ...(side === 'index' ? ['--cached'] : []),
      'HEAD',
      '--',
      ...projectionPaths,
    ]);
    if (res.code !== 0)
      throw new Error(`git diff-index failed: ${res.stderr.trim().slice(0, 300)}`);
    const fields = res.stdout.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (!wanted.has(fields[i + 1]!)) continue;
      const m = /^:(\d+) (\d+) /.exec(fields[i]!);
      if (!m || m[1] === m[2] || /^0+$/.test(m[2]!)) continue;
      if (/^0+$/.test(m[1]!) && m[2] === '100644') continue;
      changed.set(fields[i + 1]!, `${side}:${m[1]}>${m[2]}`);
    }
  }
  return changed;
}

/** HEAD reads keep readBlob's per-object pipe bound and add an aggregate projection bound. */
export function projectionHeadBlobs(
  repoPath: string,
  paths: readonly string[],
  entries: ProjectionEntries,
  totalCap: number,
): Promise<Map<string, Buffer>> {
  return readGitBlobs(
    repoPath,
    paths.flatMap((path) => {
      const oid = entryOid(entries.head.get(path));
      if (oid === null) return [];
      const size = entries.sizes.get(oid)!;
      if (size > GIT_MAX_BUFFER) throw new Error(`${path} is larger than the projection allows`);
      return [{ oid, size }];
    }),
    totalCap,
  );
}
