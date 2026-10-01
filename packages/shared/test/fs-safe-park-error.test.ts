import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  unlinkFault: null as null | { error: Error; beforeThrow: () => Promise<void> },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    // The first unlink of a parked file fails, after something has taken the name it came from.
    unlink: async (target: Parameters<typeof real.unlink>[0]) => {
      const fault = h.unlinkFault;
      if (fault !== null && String(target).includes('.haive-park-')) {
        h.unlinkFault = null;
        await fault.beforeThrow();
        throw fault.error;
      }
      return real.unlink(target);
    },
  };
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ParkedFileError, removeFileIfNoFollow, rewriteFileIfNoFollow } from '../src/fs-safe.js';

// `removeFileIfNoFollow` and `rewriteFileIfNoFollow` judge a file under a private name and move it
// back to its own. When it cannot go back (the name was taken meanwhile) they throw a
// ParkedFileError, which callers catch by class and read `parkedAt` and `code` from, and which has
// to keep what broke first when something did: the judging that threw, or the parked file's unlink.

const REL = 'src/a.txt';
const ORIGINAL = 'hello';
const PERSON = 'someone else saved this';
const REWRITTEN = 'HELLO';
const PARKED = /^src\/\.a\.txt\.haive-park-/;

const fsError = (code: 'EIO' | 'EEXIST', text: string, syscall: string): Error =>
  Object.assign(new Error(`${code}: ${text}, ${syscall}`), {
    code,
    errno: code === 'EIO' ? -5 : -17,
    syscall,
  });

async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject, and it resolved');
}

const label = (e: unknown): string =>
  e instanceof Error ? `${e.name}${'code' in e ? ` ${String(e.code)}` : ''}` : String(e);

/** Every error reachable from `err`, wherever it is attached: `cause`, an AggregateError's `errors`
 *  or any other own property holding an Error or a list of them. */
function failuresIn(err: unknown): unknown[] {
  const seen = new Set<unknown>();
  const walk = (e: unknown): void => {
    if (seen.has(e) || typeof e !== 'object' || e === null) return;
    seen.add(e);
    for (const key of Reflect.ownKeys(e)) {
      const value = (e as Record<PropertyKey, unknown>)[key];
      if (value instanceof Error) walk(value);
      else if (Array.isArray(value)) value.filter((v) => v instanceof Error).forEach(walk);
    }
  };
  walk(err);
  return [...seen];
}

/** What broke first and the put-back's own failure (link, EEXIST) are both reachable. */
function expectBothReadable(err: unknown, first: Error, what: string): void {
  const found = failuresIn(err);
  const readable = `readable from the rejection: ${found.map(label).join(', ')}`;
  expect(found, `${what} is ${readable}`).toContain(first);
  expect(
    found.some((e) => (e as { syscall?: unknown }).syscall === 'link'),
    `the put-back’s own failure (link, EEXIST) is ${readable}`,
  ).toBe(true);
}

describe('a file judged under a private name', () => {
  let root: string;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-pe-'));
    dir = path.join(root, 'src');
    file = path.join(root, REL);
    await mkdir(dir);
    await writeFile(file, ORIGINAL, { encoding: 'utf8', mode: 0o600 });
  });

  afterEach(async () => {
    h.unlinkFault = null;
    await rm(root, { recursive: true, force: true });
  });

  /** What a ParkedFileError has to tell a caller whatever else it carries: the class, where the
   *  file is (and that it is there, holding `parkedBytes`), and the errno of the failed put-back. */
  async function expectParked(err: unknown, parkedBytes: string): Promise<ParkedFileError> {
    expect(err, 'a ParkedFileError, which callers catch by class').toBeInstanceOf(ParkedFileError);
    const parked = err as ParkedFileError;
    expect(parked.parkedAt, 'parkedAt names the private entry').toMatch(PARKED);
    expect(
      await readFile(path.join(root, parked.parkedAt), 'utf8'),
      'parkedAt names a file that exists and holds the parked bytes',
    ).toBe(parkedBytes);
    expect(parked.code, 'code is the errno of the put-back').toBe('EEXIST');
    expect(await readFile(file, 'utf8'), 'the file saved meanwhile stands').toBe(PERSON);
    return parked;
  }

  const takeTheName = (): Promise<void> => writeFile(file, PERSON, 'utf8');

  // The judge is `edit` for a rewrite and `accept` for a removal; either may throw.
  const JUDGES = [
    {
      name: 'rewriteFileIfNoFollow',
      run: (judge: () => Promise<never>) => rewriteFileIfNoFollow(root, REL, judge),
    },
    {
      name: 'removeFileIfNoFollow',
      run: (judge: () => Promise<never>) => removeFileIfNoFollow(root, REL, judge),
    },
  ];

  it.each(JUDGES)(
    'C7 $name reads the judge’s error when putting the file back fails too',
    async (j) => {
      const boom = new Error('the judge refused');
      const err = await rejection(
        j.run(async () => {
          await takeTheName();
          throw boom;
        }),
      );

      await expectParked(err, ORIGINAL);
      expectBothReadable(err, boom, 'the judge’s error');
    },
  );

  it('C7 removeFileIfNoFollow reads the failed unlink when putting the file back fails too', async () => {
    const eio = fsError('EIO', 'input/output error', 'unlink');
    h.unlinkFault = { error: eio, beforeThrow: takeTheName };

    const err = await rejection(removeFileIfNoFollow(root, REL, () => true));

    expect(h.unlinkFault, 'the parked file’s unlink was reached and failed').toBeNull();
    await expectParked(err, ORIGINAL);
    expectBothReadable(err, eio, 'the unlink’s error');
  });

  const PUT_BACKS = [
    {
      name: 'removeFileIfNoFollow',
      parkedBytes: ORIGINAL,
      run: () =>
        removeFileIfNoFollow(root, REL, async () => {
          await takeTheName();
          return false;
        }),
    },
    {
      name: 'rewriteFileIfNoFollow',
      parkedBytes: REWRITTEN,
      run: () =>
        rewriteFileIfNoFollow(root, REL, async () => {
          await takeTheName();
          return Buffer.from(REWRITTEN, 'utf8');
        }),
    },
  ];

  it.each(PUT_BACKS)(
    'C8 $name still throws a plain ParkedFileError when only the put-back fails',
    async (p) => {
      const err = await rejection(p.run());

      const parked = await expectParked(err, p.parkedBytes);
      expect(parked.message).toMatch(/could not be put back \(EEXIST\); it is at src\/\.a\.txt\./);
      const others = failuresIn(err).filter((e) => e !== err);
      expect(
        others.map(label),
        'the only error beside it is the put-back’s own (link, EEXIST)',
      ).toEqual(['Error EEXIST']);
      expect(others[0]).toMatchObject({ syscall: 'link' });
    },
  );

  it.each(JUDGES)('C8 $name rethrows the judge’s own error when the file goes back', async (j) => {
    const boom = new Error('the judge refused');

    const err = await rejection(
      j.run(async () => {
        throw boom;
      }),
    );

    expect(err, 'the very error the judge threw, not a wrapper').toBe(boom);
    expect(await readFile(file, 'utf8'), 'the file is back at its name').toBe(ORIGINAL);
    expect(await readdir(dir), 'nothing is left beside it').toEqual(['a.txt']);
  });

  it('C8 removeFileIfNoFollow rethrows the unlink’s own error when the file goes back', async () => {
    const eio = fsError('EIO', 'input/output error', 'unlink');
    h.unlinkFault = { error: eio, beforeThrow: async () => {} };

    const err = await rejection(removeFileIfNoFollow(root, REL, () => true));

    expect(h.unlinkFault, 'the parked file’s unlink was reached and failed').toBeNull();
    expect(err, 'the very error the unlink threw, not a wrapper').toBe(eio);
    expect(await readFile(file, 'utf8'), 'the file is back at its name').toBe(ORIGINAL);
    expect(await readdir(dir), 'nothing is left beside it').toEqual(['a.txt']);
  });
});
