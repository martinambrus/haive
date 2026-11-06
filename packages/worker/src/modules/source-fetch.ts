import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureDirNoFollow,
  readFileNoFollow,
  readdirSizesNoFollow,
  removeNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { MODULE_ID_PATTERN } from '@haive/shared/modularity';
import { isBranchName } from '@haive/shared/git-args';
import { safeErrorMessage, scrubErrorPaths } from '@haive/shared/logger';
import { assertCloneUrl } from '../repo/clone.js';
import { gitRun, type GitRunResult } from '../repo/git-exec.js';
import { originGitRun, scrubSecret } from '../repo/git-push.js';
import { shellQuote } from '../sandbox/shell-quote.js';
import { pinModuleTree, resolveWorkerImage } from './source-pin.js';

export type FetchSource = {
  id: string;
  moduleId: string;
  kind: string;
  url: string | null;
  ref: string | null;
  resolvedSha: string | null;
  resolvedRef?: string | null;
};

export function sourceFetchError(error: unknown, token: string | null): string {
  return scrubErrorPaths(scrubSecret(safeErrorMessage(error), token)).slice(0, 4096);
}

const MODULE_TREE_BYTES = 64 * 1024 * 1024;

/** Bound git's on-disk transfer too, including temporary packfiles before checkout. */
async function boundedTransfer<T>(
  root: string,
  transfer: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let failure: unknown;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = Promise.resolve();
  const check = async () => {
    let bytes = 0;
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 32) throw new Error('Module tree exceeds depth limit');
      for (const entry of (await readdirSizesNoFollow(root, rel)) ?? []) {
        if (entry.isDirectory) await walk(rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
        else bytes += entry.size ?? 0;
        if (bytes > MODULE_TREE_BYTES) throw new Error('Module tree exceeds size limit');
      }
    };
    await walk('', 0);
  };
  const poll = () => {
    checking = check()
      .catch((error) => {
        failure = error;
        controller.abort();
      })
      .then(() => {
        if (!stopped && !failure) timer = setTimeout(poll, 25);
      });
  };
  poll();
  try {
    const result = await transfer(controller.signal);
    await checking;
    if (failure) throw failure;
    await check();
    return result;
  } catch (error) {
    throw failure ?? error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    await checking;
  }
}

async function validateTree(root: string, moduleId: string): Promise<void> {
  let count = 0;
  let size = 0;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('Module tree exceeds depth limit');
    const entries = await readdirSizesNoFollow(root, rel);
    if (!entries) throw new Error('Module tree is missing');
    for (const entry of entries) {
      count++;
      if (count > 5000) throw new Error('Module tree exceeds entry limit');
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === '.git') throw new Error('Nested git metadata is refused');
      if (entry.isDirectory) await walk(child, depth + 1);
      else {
        if (entry.size === null) throw new Error('Module links and special files are refused');
        size += entry.size;
        if (size > MODULE_TREE_BYTES) throw new Error('Module tree exceeds size limit');
      }
    }
  }
  await walk('', 0);
  const file = await readFileNoFollow(root, 'package.json', {
    maxBytes: 1024 * 1024,
    strict: true,
  });
  if (!file || file.truncated) throw new Error('Module package.json is missing or too large');
  const pkg = JSON.parse(file.data.toString('utf8'));
  if (pkg.name !== '@haive-module/' + moduleId || !pkg.exports?.['./manifest'])
    throw new Error('Expected @haive-module/' + moduleId + ' exporting ./manifest');
}

function moduleSourceUrl(raw: string): URL {
  assertCloneUrl(raw);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || /[?#\s\\]/.test(raw))
    throw new Error('Module sources require HTTPS without credentials, query or fragment');
  return url;
}

export async function fetchModuleSource(
  source: FetchSource,
  token: string | null,
  pin: (
    tree: string,
    hostDir: string,
    moduleId: string,
    image: string,
  ) => Promise<void> = pinModuleTree,
  resolved: (sha: string, ref: string | null) => Promise<void> = async () => {},
  validateUrl: (raw: string) => URL = moduleSourceUrl,
): Promise<string> {
  if (process.env.HAIVE_PUBLISHED_INSTALL !== 'true')
    throw new Error('Module fetch requires a published install');
  const hostDir = process.env.HAIVE_OWN_MODULES_HOST_DIR;
  if (!hostDir || !hostDir.startsWith('/') || /[,\r\n\0]/.test(hostDir))
    throw new Error(
      'HAIVE_OWN_MODULES_HOST_DIR must name an absolute daemon directory without commas',
    );
  if (source.kind !== 'git')
    throw new Error('Registry fetch is unavailable: the builder requires rebuildable sources');
  if (!MODULE_ID_PATTERN.test(source.moduleId)) throw new Error('Invalid module id');
  const ref = source.ref;
  if (
    !ref ||
    !isBranchName(ref) ||
    ref.startsWith('+') ||
    ref.startsWith('refs/') ||
    /\s/.test(ref)
  )
    throw new Error('Invalid module branch or tag ref');
  const url = validateUrl(source.url ?? '');
  if (source.resolvedSha !== null && !/^[a-f0-9]{40}$/.test(source.resolvedSha))
    throw new Error('Invalid recorded SHA');
  if (source.resolvedRef && ![`refs/heads/${ref}`, `refs/tags/${ref}`].includes(source.resolvedRef))
    throw new Error('Invalid recorded ref namespace');
  const image = await resolveWorkerImage();
  const temporary = await mkdtemp(join(tmpdir(), 'haive-worker-module-source-'));
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let input = '';
    socket.on('data', (data) => {
      input += data.toString();
      if (input.length > 8192) socket.destroy();
    });
    socket.on('end', () => {
      const fields = new Map(
        input.split('\n').map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
      );
      socket.end(
        fields.get('protocol') === 'https' &&
          fields.get('host')?.toLowerCase() === url.host.toLowerCase()
          ? `username=x-access-token\npassword=${token ?? ''}\n\n`
          : '\n',
      );
    });
  });
  try {
    if (token && /[\r\n\0]/.test(token))
      throw new Error('Module access token contains invalid characters');
    const socketPath = join(temporary, 'credential.sock');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const helper = join(temporary, 'credential.cjs');
    await writeFileNoFollow(
      temporary,
      'credential.cjs',
      `if(process.argv[2]==='get'){const net=require('node:net');const s=net.createConnection(${JSON.stringify(socketPath)});s.on('error',()=>process.exit(1));process.stdin.pipe(s);s.pipe(process.stdout);}`,
    );
    await ensureDirNoFollow(temporary, 'tree', { mode: 0o755 });
    const tree = join(temporary, 'tree');
    const auth = [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=!node ${shellQuote(helper)}`,
      '-c',
      'http.followRedirects=false',
    ];
    const env = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TEMPLATE_DIR: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
      GIT_TRACE: '0',
      GIT_TRACE_CURL: '0',
      GIT_CURL_VERBOSE: '0',
      GIT_TRACE_PACKET: '0',
      GIT_TRACE2: '0',
      GIT_TRACE2_EVENT: '0',
      GIT_TRACE2_PERF: '0',
      GIT_TRACE_REDACT: '1',
    };
    const io = { timeout: 300_000, maxBuffer: 1024 * 1024 };
    const output = (result: GitRunResult) => {
      if (result.code !== 0)
        throw new Error(
          'Module git fetch failed: ' + sourceFetchError(new Error(result.stderr), token),
        );
      return result.stdout.trim();
    };
    const run = async (args: string[]) => output(await gitRun(tree, [...auth, ...args], env, io));
    await run(['init']);
    await run(['remote', 'add', 'origin', url.href]);
    const heads = `refs/heads/${ref}`;
    const tags = `refs/tags/${ref}`;
    let qualifiedRef = source.resolvedSha ? (source.resolvedRef ?? undefined) : undefined;
    const listRefs = async () => {
      const listing = output(
        await originGitRun(
          tree,
          [...auth, 'ls-remote', '--end-of-options', url.href, heads, tags, `${tags}^{}`],
          env,
          io,
        ),
      );
      const refs = new Map(
        listing
          .split('\n')
          .map((line) => line.split('\t') as [string, string])
          .map(([sha, name]) => [name, sha]),
      );
      // Legacy pins have no recorded namespace. Prefer a namespace still pointing at the pin.
      qualifiedRef ??=
        source.resolvedSha &&
        refs.get(heads) !== source.resolvedSha &&
        (refs.get(`${tags}^{}`) ?? refs.get(tags)) === source.resolvedSha
          ? tags
          : refs.has(heads)
            ? heads
            : refs.has(tags)
              ? tags
              : undefined;
      return refs;
    };
    let sha = source.resolvedSha;
    if (!sha) {
      const refs = await listRefs();
      sha = refs.get(heads) ?? refs.get(`${tags}^{}`) ?? refs.get(tags) ?? null;
      if (!sha || !/^[a-f0-9]{40}$/.test(sha))
        throw new Error('Module branch or tag was not found');
    }
    const fetch = (target: string) =>
      boundedTransfer(tree, (signal) =>
        originGitRun(
          tree,
          [...auth, 'fetch', '--no-tags', '--depth=1', '--end-of-options', url.href, target],
          env,
          { ...io, signal },
        ),
      );
    const byObject = await fetch(sha);
    if (byObject.code !== 0) {
      if (!qualifiedRef) await listRefs();
      if (!qualifiedRef || (await fetch(qualifiedRef)).code !== 0)
        throw new Error('module_source_ref_unavailable: Module branch or tag was not found');
    }
    const commit = await run(['rev-parse', '--verify', '--end-of-options', 'FETCH_HEAD^{commit}']);
    if (commit !== sha)
      throw new Error('module_source_ref_moved: Fetched commit does not match the pinned SHA');
    await resolved(sha, qualifiedRef ?? null);
    await run(['checkout', '--detach', sha, '--']);
    await removeNoFollow(tree, '.git', { recursive: true });
    await validateTree(tree, source.moduleId);
    await writeFileNoFollow(
      tree,
      '.haive-source.json',
      JSON.stringify({
        module_id: source.moduleId,
        kind: 'git',
        url: url.href,
        ref,
        sha,
        fetched_at: new Date().toISOString(),
      }),
    );
    await pin(tree, hostDir, source.moduleId, image);
    return sha;
  } catch (error) {
    throw new Error(sourceFetchError(error, token));
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
}
