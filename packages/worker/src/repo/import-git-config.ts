import {
  decodeUtf8Strict,
  lstatNoFollow,
  openDirNoFollow,
  openFileNoFollow,
  readdirNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { hardenGitArgs } from '@haive/shared/git-args';
import { isAllowedGitRemoteUrl } from '@haive/shared/schemas';
import { childFd, FIRST_SLOT, runTool } from './tool-spawn.js';

const REFUSAL =
  'Uploaded Git metadata is unsafe or unsupported. Upload a complete standalone checkout ' +
  'with a .git directory and valid version-0 configuration; partial clones, shared object ' +
  'stores and linked worktrees are not supported.';
const IMPORT_GIT_CONFIG_NOTE =
  'Uploaded Git configuration was restricted to safe repository, branch and remote settings.';

const CORE_KEYS = new Set([
  'repositoryformatversion',
  'bare',
  'filemode',
  'logallrefupdates',
  'ignorecase',
  'precomposeunicode',
  'symlinks',
  'autocrlf',
  'eol',
  'safecrlf',
]);
const BRANCH_KEYS = new Set(['remote', 'merge', 'pushremote', 'description']);
const REMOTE_KEYS = new Set(['url', 'pushurl', 'fetch', 'push', 'tagopt']);

/** Quote only a decoded value/subsection, never config syntax from the upload. Git itself parses
 * the input; --null --list frames each record as key LF value NUL (no LF for an implicit bool). */
function quote(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\x08/g, '\\b') +
    '"'
  );
}

function safeConfig(list: string): string {
  const kept: string[] = [];
  let versionSeen = false;
  for (const record of list.split('\0').slice(0, -1)) {
    const newline = record.indexOf('\n');
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? null : record.slice(newline + 1);
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    const section = key.slice(0, first);
    const name = key.slice(last + 1);
    const subsection = first === last ? null : key.slice(first + 1, last);
    // These describe a different repository/object layout. Stripping them could silently turn
    // incomplete history into an apparently ordinary checkout, so refuse instead.
    if (
      section === 'extensions' ||
      key === 'core.worktree' ||
      (section === 'remote' && ['promisor', 'partialclonefilter'].includes(name))
    ) {
      throw new Error(REFUSAL);
    }
    if (key === 'core.repositoryformatversion') {
      if (value !== '0') throw new Error(REFUSAL);
      versionSeen = true;
    }
    if (key === 'core.bare' && !['false', 'no', 'off', '0'].includes(value?.toLowerCase() ?? '')) {
      throw new Error(REFUSAL);
    }
    const allowed =
      (section === 'core' && subsection === null && CORE_KEYS.has(name)) ||
      (section === 'user' && subsection === null && ['name', 'email'].includes(name)) ||
      (section === 'branch' && subsection !== null && BRANCH_KEYS.has(name)) ||
      (section === 'remote' && subsection !== null && REMOTE_KEYS.has(name));
    if (!allowed) continue;
    if (
      section === 'remote' &&
      ['url', 'pushurl'].includes(name) &&
      (value === null || !isAllowedGitRemoteUrl(value))
    )
      continue;
    kept.push(
      `[${section}${subsection === null ? '' : ' ' + quote(subsection)}]\n\t${name}${value === null ? '' : ' = ' + quote(value)}\n`,
    );
  }
  if (!versionSeen) throw new Error(REFUSAL);
  return kept.join('');
}

/** Only for an uploaded repository, while its candidate is still private. Never applied to a
 * person's external folder, bundle contents or attachments. No Git command sees the candidate's
 * config until it has been replaced. Neither includes nor ambient GIT_* reach the parser. */
export async function sanitizeImportedGitConfig(
  anchor: string,
  rootRel: string,
): Promise<string | null> {
  try {
    const gitRel = `${rootRel}/.git`;
    const info = await lstatNoFollow(anchor, gitRel, { strict: true });
    if (info === null) {
      // Git also discovers a bare repository in cwd without a .git entry. It would otherwise
      // interpret this root's config on the first detection read.
      const head = await lstatNoFollow(anchor, `${rootRel}/HEAD`, { strict: true });
      const objects = await lstatNoFollow(anchor, `${rootRel}/objects`, { strict: true });
      const refs = await lstatNoFollow(anchor, `${rootRel}/refs`, { strict: true });
      if (head?.kind === 'file' && objects?.kind === 'directory' && refs?.kind === 'directory') {
        throw new Error(REFUSAL);
      }
      return null; // A source-only archive is still a normal repository upload.
    }
    if (info.kind !== 'directory') throw new Error(REFUSAL);
    for (const rel of [
      'commondir',
      'gitdir',
      'worktrees',
      'config.worktree',
      'shallow',
      'objects/info/alternates',
      'objects/info/http-alternates',
    ]) {
      if (await lstatNoFollow(anchor, `${gitRel}/${rel}`, { strict: true }))
        throw new Error(REFUSAL);
    }
    const packs = await readdirNoFollow(anchor, `${gitRel}/objects/pack`, { strict: true });
    if (packs?.some((entry) => entry.name.endsWith('.promisor'))) throw new Error(REFUSAL);
    const configRel = `${gitRel}/config`;
    const config = await openFileNoFollow(anchor, configRel, 'read', { strict: true });
    if (!config) throw new Error(REFUSAL);
    let sanitized: string;
    try {
      if ((await config.stat()).size > 1024 * 1024) throw new Error(REFUSAL);
      if (decodeUtf8Strict(await config.readFile()) === null) throw new Error(REFUSAL);
      const parsed = await runTool(
        'git',
        hardenGitArgs(['-C', '/', 'config', '--no-includes', '--null', '--file', '-', '--list']),
        { stdin: config, maxStdout: 2 * 1024 * 1024, signal: AbortSignal.timeout(30_000) },
      );
      sanitized = safeConfig(parsed.stdout);
    } finally {
      await config.close();
    }
    await writeFileNoFollow(anchor, configRel, sanitized, { mode: 'overwrite-in-place' });

    // A missing object is a refusal, never permission to fetch from an uploaded promisor. The
    // config now has no promisor/transport programs, and no pack promises survived the check above.
    // Git must stay in the held metadata directory: resolving its absolute path as uid 65534
    // cannot traverse the root worker's 0700 stage parent. The optional commit-graph/MIDX
    // validators also re-open canonical paths, so check connectivity from the objects directly,
    // with those acceleration caches disabled for this invocation only.
    const gitDir = await openDirNoFollow(anchor, gitRel);
    try {
      await runTool(
        'git',
        hardenGitArgs([
          '-C',
          childFd(FIRST_SLOT),
          '--git-dir=.',
          '-c',
          'core.commitGraph=false',
          '-c',
          'core.multiPackIndex=false',
          'fsck',
          '--connectivity-only',
          '--no-dangling',
        ]),
        { fds: [gitDir], maxStdout: 1024 * 1024, signal: AbortSignal.timeout(10 * 60_000) },
      );
    } finally {
      await gitDir.close();
    }
    return IMPORT_GIT_CONFIG_NOTE;
  } catch {
    // Git's parser and fsck diagnostics can contain config values, refs or paths from the upload.
    // Keep the refusal actionable without ever storing or logging those untrusted diagnostics.
    throw new Error(REFUSAL);
  }
}
