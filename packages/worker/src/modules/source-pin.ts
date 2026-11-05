import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { safeErrorMessage, scrubErrorPaths } from '@haive/shared/logger';
import { basename, dirname } from 'node:path';
import { CONTAINER_FAMILY, containerName, logger } from '@haive/shared';
import { openDirNoFollow, openFileNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { childFd, runTool } from '../repo/tool-spawn.js';

export const PIN_SCRIPT = String.raw`
import ctypes, fcntl, json, os, re, shutil, stat, sys, tarfile, uuid
root, module = sys.argv[1:]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,22}', module):
    raise RuntimeError('invalid module id')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
owner = os.stat(root, follow_symlinks=False)
if os.geteuid() == 0:
    os.setgroups([])
    os.setgid(owner.st_gid)
    os.setuid(owner.st_uid)
fd = os.open(root, flags)
fcntl.flock(fd, fcntl.LOCK_EX)
for stale in os.listdir(fd):
    if stale.startswith('.' + module + '.tmp-'):
        if stat.S_ISDIR(os.stat(stale, dir_fd=fd, follow_symlinks=False).st_mode):
            shutil.rmtree(stale, dir_fd=fd)
        else:
            os.unlink(stale, dir_fd=fd)
stage = '.' + module + '.tmp-' + str(uuid.uuid4())
os.mkdir(stage, 0o755, dir_fd=fd)
staged = os.open(stage, flags, dir_fd=fd)
def marker(at):
    file = os.open('.haive-source.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=at)
    with os.fdopen(file) as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise RuntimeError('invalid source marker')
        if json.loads(stream.read(16384)).get('module_id') != module:
            raise RuntimeError('invalid source marker')
try:
    size = 0
    count = 0
    with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
        for item in archive:
            parts = item.name.split('/')
            while parts and parts[0] == '.': parts.pop(0)
            if not parts: continue
            if any(p in ('', '.', '..', '.git') for p in parts) or item.name.startswith('/') or len(parts) > 32:
                raise RuntimeError('invalid archive path')
            count += 1
            size += item.size
            if count > 5000 or size > 64 * 1024 * 1024:
                raise RuntimeError('module tree exceeds limit')
            parent = os.dup(staged)
            try:
                for part in parts[:-1]:
                    try: os.mkdir(part, 0o755, dir_fd=parent)
                    except FileExistsError: pass
                    child = os.open(part, flags, dir_fd=parent)
                    os.close(parent)
                    parent = child
                if item.isdir():
                    try: os.mkdir(parts[-1], 0o755, dir_fd=parent)
                    except FileExistsError:
                        child = os.open(parts[-1], flags, dir_fd=parent)
                        os.close(child)
                elif item.isfile():
                    file = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if item.mode & 0o111 else 0o644, dir_fd=parent)
                    with os.fdopen(file, 'wb') as out, archive.extractfile(item) as stream:
                        shutil.copyfileobj(stream, out)
                else:
                    raise RuntimeError('module links and special files are refused')
            finally:
                os.close(parent)
    marker(staged)
    try: previous = os.stat(module, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError: previous = None
    if previous is not None:
        if not stat.S_ISDIR(previous.st_mode):
            raise RuntimeError('module destination must be a directory')
        target = os.open(module, flags, dir_fd=fd)
        try:
            try: marker(target)
            except (OSError, ValueError, RuntimeError):
                raise RuntimeError('Refusing to replace an unmarked module directory') from None
        finally: os.close(target)
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if rename(fd, stage.encode(), fd, module.encode(), 2 if previous else 1):
        raise OSError(ctypes.get_errno(), 'atomic pin failed')
finally:
    os.close(staged)
    try: shutil.rmtree(stage, dir_fd=fd)
    except FileNotFoundError: pass
    os.close(fd)
`;

const exec = promisify(execFile);

export async function resolveWorkerImage(
  container: string = hostname(),
  inspect: (container: string) => Promise<string> = async (name) =>
    (
      await exec('docker', ['container', 'inspect', '--format', '{{.Image}}', '--', name], {
        timeout: 15_000,
        maxBuffer: 4096,
      })
    ).stdout,
): Promise<string> {
  try {
    const image = (await inspect(container)).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Invalid worker image id');
    return image;
  } catch {
    throw new Error(
      'module_source_worker_image_unavailable: Cannot resolve this worker container image',
    );
  }
}

export function modulePinError(error: unknown, hostDir: string): Error {
  const failure = error as { stderr?: string; code?: unknown; signal?: string };
  const detail =
    failure.stderr?.trim().split('\n').at(-1) ||
    failure.signal ||
    failure.code ||
    safeErrorMessage(error);
  return new Error(
    'Module pin failed: ' + scrubErrorPaths(String(detail).split(hostDir).join('[path]')),
  );
}

export async function pinModuleTree(
  tree: string,
  hostDir: string,
  moduleId: string,
): Promise<void> {
  const image = await resolveWorkerImage();
  const dir = await openDirNoFollow(dirname(tree), basename(tree));
  const rel = '.haive-archive-' + randomUUID();
  const created = await openFileNoFollow(tree, rel, 'create-exclusive', { fileMode: 0o600 }).catch(
    async (error) => {
      await dir.close();
      throw error;
    },
  );
  await created!.close();
  const archive = (await openFileNoFollow(tree, rel, 'read').catch(async (error) => {
    await dir.close();
    throw error;
  }))!;
  const name = containerName(CONTAINER_FAMILY.moduleSource, randomUUID());
  logger.info({ container: name, moduleId }, 'Pinning module source');
  try {
    await removeNoFollow(tree, rel);
    await archive.chmod(0o666);
    await runTool('tar', ['-cf', childFd(4), '-C', childFd(3), '.'], {
      fds: [dir, archive],
      signal: AbortSignal.timeout(120_000),
    });
    if ((await archive.stat()).size > 72 * 1024 * 1024)
      throw new Error('Module archive exceeds limit');
    const run = exec(
      'docker',
      [
        'run',
        '--rm',
        '--pull',
        'never',
        '-i',
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'SETUID',
        '--cap-add',
        'SETGID',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '64',
        '--memory',
        '256m',
        '--mount',
        `type=bind,src=${hostDir},dst=/output`,
        image,
        'python3',
        '-B',
        '-c',
        PIN_SCRIPT,
        '/output',
        moduleId,
      ],
      { timeout: 120_000, maxBuffer: 64 * 1024 },
    );
    const input = archive.createReadStream({ start: 0, autoClose: false });
    run.child.stdin!.on('error', () => input.destroy());
    input.on('error', () => run.child.kill('SIGKILL'));
    input.pipe(run.child.stdin!);
    try {
      await run;
    } catch (error) {
      throw modulePinError(error, hostDir);
    } finally {
      input.destroy();
    }
  } finally {
    await exec('docker', ['rm', '-f', name], { timeout: 15_000 }).catch(() => undefined);
    await Promise.all([archive.close(), dir.close()]);
  }
}
