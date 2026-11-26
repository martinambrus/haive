import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
import { readAttemptInstallFields } from './attempt-fields.js';

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

it.each(['regular', 'linked'] as const)(
  'finishes lstat before opening a %s display env file',
  async (kind) => {
    dir = await fs.mkdtemp(join(tmpdir(), 'attempt-order-'));
    const file = join(dir, '.env');
    const text = `HAIVE_VERSION=${randomBytes(12).toString('hex')}\n`;
    if (kind === 'regular') await fs.writeFile(file, text);
    else {
      await fs.writeFile(join(dir, 'private'), text);
      await fs.symlink(join(dir, 'private'), file);
    }
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(fs.lstat).mockImplementationOnce(async (...args) => {
      entered();
      await pending;
      return actual.lstat(...args);
    });
    const read = readAttemptInstallFields(dir);
    try {
      await started;
      // The directory is open, but .env must stay unopened while lstat is pending.
      expect(vi.mocked(fs.open).mock.calls.map(([path]) => String(path))).not.toContainEqual(
        expect.stringMatching(/\/\.env$/),
      );
    } finally {
      release();
    }
    const result = await read;
    const envOpens = vi
      .mocked(fs.open)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => path.endsWith('/.env'));
    expect(vi.mocked(fs.lstat).mock.calls[0]![0]).toMatch(/^\/proc\/self\/fd\/\d+\/\.env$/);
    if (kind === 'regular') {
      expect(envOpens).toEqual([vi.mocked(fs.lstat).mock.calls[0]![0]]);
      expect(result.fromVersion).toBe(text.split('=')[1]!.trim());
    } else {
      expect(envOpens).toEqual([]);
      expect(result.channel).toBe('not-read');
    }
  },
);
