import { link, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTRACT_UID, FIRST_SLOT, childFd, letToolRead, runTool } from '../src/repo/tool-spawn.js';

const have = (tool: string): boolean => {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('runTool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tool-spawn-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const held = async (name: string, content: string | Buffer) => {
    await writeFile(path.join(dir, name), content, { mode: 0o644 });
    return open(path.join(dir, name), 'r');
  };

  it('hands the child its descriptors in slot order', async () => {
    const a = await held('a.txt', 'first\n');
    const b = await held('b.txt', 'second\n');
    try {
      const { stdout } = await runTool(
        'sh',
        ['-c', `cat ${childFd(FIRST_SLOT)} ${childFd(FIRST_SLOT + 1)}`],
        { fds: [a, b], maxStdout: 1024 },
      );
      expect(stdout).toBe('first\nsecond\n');
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('passes the child no descriptor it was not handed', async () => {
    const other = await held('other.txt', 'not for the child');
    try {
      const { stdout } = await runTool(
        'sh',
        ['-c', `[ -e /proc/self/fd/${other.fd} ] && echo inherited || echo clean`],
        { maxStdout: 64 },
      );
      expect(stdout.trim()).toBe('clean');
    } finally {
      await other.close();
    }
  });

  it("gives the child PATH and LANG and none of the worker's environment", async () => {
    process.env.HAIVE_TOOL_SPAWN_SECRET = 'must-not-leak';
    try {
      const { stdout } = await runTool('sh', ['-c', 'env'], { maxStdout: 64 * 1024 });
      const names = stdout
        .split('\n')
        .map((line) => line.split('=')[0])
        .filter((n) => n && n !== 'PWD' && n !== 'SHLVL' && n !== '_');
      expect(names.sort()).toEqual(['LANG', 'PATH']);
    } finally {
      delete process.env.HAIVE_TOOL_SPAWN_SECRET;
    }
  });

  it('streams stdin from the start of the held file', async () => {
    const input = await held('in.txt', 'streamed through stdin');
    try {
      await input.read(Buffer.alloc(4), 0, 4, null);
      const { stdout } = await runTool('cat', [], { stdin: input, maxStdout: 1024 });
      expect(stdout).toBe('streamed through stdin');
    } finally {
      await input.close();
    }
  });

  it('kills a child that writes more than it may and fails', async () => {
    await expect(
      runTool('sh', ['-c', 'yes | head -c 100000'], { maxStdout: 1000 }),
    ).rejects.toThrow(/more than 1000 bytes/);
  });

  it('kills a child when aborted, reporting the abort', async () => {
    await expect(
      runTool('sleep', ['30'], { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ code: 'ABORT_ERR' });
  });

  it('fails on an exit it was not told to accept, and accepts one it was', async () => {
    await expect(runTool('sh', ['-c', 'echo nope >&2; exit 3'])).rejects.toThrow(/exit 3\): nope/);
    await expect(
      runTool('sh', ['-c', 'echo careful >&2; exit 1'], { okExits: [0, 1] }),
    ).resolves.toMatchObject({ exitCode: 1, stderr: 'careful\n' });
  });

  it.runIf(process.getuid?.() === 0)(
    'runs the child as the unprivileged extraction uid',
    async () => {
      const { stdout } = await runTool('id', ['-u'], { maxStdout: 64 });
      expect(Number(stdout.trim())).toBe(EXTRACT_UID);
    },
  );

  it.runIf(have('unzip'))('lets unzip read an archive through its slot', async () => {
    const zip = new JSZip();
    zip.file('docs/readme.md', '# held\n');
    const archive = await held('held.zip', await zip.generateAsync({ type: 'nodebuffer' }));
    try {
      const { stdout } = await runTool('unzip', ['-Z1', childFd(FIRST_SLOT)], {
        fds: [archive],
        maxStdout: 4096,
      });
      expect(stdout.split('\n').filter(Boolean)).toContain('docs/readme.md');
    } finally {
      await archive.close();
    }
  });

  describe.runIf(process.getuid?.() === 0)('letToolRead', () => {
    it('opens a file only the worker could read to the extraction uid while it needs it', async () => {
      const fh = await held('private.txt', 'owner only');
      try {
        await fh.chmod(0o600);
        const restore = await letToolRead(fh);
        expect((await stat(path.join(dir, 'private.txt'))).mode & 0o777).toBe(0o604);
        const { stdout } = await runTool('cat', [childFd(FIRST_SLOT)], {
          fds: [fh],
          maxStdout: 64,
        });
        expect(stdout).toBe('owner only');
        // Opened up only while the tool runs: the restore puts the file's own mode back.
        await restore!();
        expect((await stat(path.join(dir, 'private.txt'))).mode & 0o777).toBe(0o600);
      } finally {
        await fh.close();
      }
    });

    it('refuses a file with another name rather than opening that name up too', async () => {
      const fh = await held('shared.txt', 'two names');
      try {
        await fh.chmod(0o600);
        await link(path.join(dir, 'shared.txt'), path.join(dir, 'other-name.txt'));
        await expect(letToolRead(fh)).rejects.toThrow(/other links/);
        expect((await stat(path.join(dir, 'other-name.txt'))).mode & 0o777).toBe(0o600);
      } finally {
        await fh.close();
      }
    });
  });
});
