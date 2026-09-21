import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';

// WORKER_REPO_STORAGE_ROOT is read from the environment ONCE, at import time, so the fixture root
// has to exist and be exported before secret-mask.js is pulled in. Same reason as
// secret-mask-resolve.test.ts, which this file mirrors.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-persona-recheck-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const { assertPastedPersonasStillAllowed, SecretMaskError } =
  await import('../src/queues/cli-exec/secret-mask.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const TASK_ID = '33333333-3333-3333-3333-333333333333';
const PERSONA = '.claude/agents/peer-reviewer.md';

type Row = Record<string, unknown> | undefined;

/** The only two lookups the recheck makes, which is why the function was kept to them. */
function fakeDb(task: Row, repo: Row): { db: Database; queries: string[] } {
  const queries: string[] = [];
  const db = {
    query: {
      tasks: {
        findFirst: () => {
          queries.push('tasks');
          return Promise.resolve(task);
        },
      },
      repositories: {
        findFirst: () => {
          queries.push('repositories');
          return Promise.resolve(repo);
        },
      },
    },
  } as unknown as Database;
  return { db, queries };
}

const repoRow = (over: Record<string, unknown> = {}) => ({
  storagePath: null,
  localPath: null,
  secretMaskEnabled: true,
  secretMaskAllow: null,
  secretMaskDenyExtend: null,
  ...over,
});

const taskRow = { userId: USER_ID, repositoryId: REPO_ID };

beforeEach(async () => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  await rm(path.join(storageRoot, USER_ID), { recursive: true, force: true });
  await mkdir(path.join(storageRoot, USER_ID, REPO_ID, '.claude', 'agents'), { recursive: true });
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('assertPastedPersonasStillAllowed', () => {
  it('runs NO query when nothing was pasted', async () => {
    // Every invocation outside isolation pastes nothing, so this is the common path and it must cost
    // nothing at all.
    const { db, queries } = fakeDb(taskRow, repoRow());
    await expect(assertPastedPersonasStillAllowed(db, TASK_ID, null, [])).resolves.toBeUndefined();
    expect(queries).toEqual([]);
  });

  it('allows a pasted path under the default policy', async () => {
    // No default deny glob matches a .md under an agents directory.
    const { db } = fakeDb(taskRow, repoRow());
    await expect(
      assertPastedPersonasStillAllowed(db, TASK_ID, null, [PERSONA]),
    ).resolves.toBeUndefined();
  });

  it('REFUSES the invocation when the policy now denies a pasted path', async () => {
    // The repository added `**/*.md` to its deny globs after the prompt was built. The body is
    // already in the prompt and cannot be unsent, so the run is refused instead.
    const { db } = fakeDb(taskRow, repoRow({ secretMaskDenyExtend: ['**/*.md'] }));
    await expect(assertPastedPersonasStillAllowed(db, TASK_ID, null, [PERSONA])).rejects.toThrow(
      SecretMaskError,
    );
    await expect(assertPastedPersonasStillAllowed(db, TASK_ID, null, [PERSONA])).rejects.toThrow(
      /peer-reviewer\.md/,
    );
  });

  it('asks the POLICY, not the mask set: a DELETED denied path still refuses', async () => {
    // computeSecretMasks only mounts over files that still exist, so a denied file deleted after
    // dispatch produces no mount while its bytes are already in the prompt. An absent mask is never
    // evidence of an allowed path.
    const { db } = fakeDb(taskRow, repoRow({ secretMaskDenyExtend: ['**/*.md'] }));
    await expect(
      assertPastedPersonasStillAllowed(db, TASK_ID, null, ['.claude/agents/never-existed.md']),
    ).rejects.toThrow(SecretMaskError);
  });

  it('allows a denied path that is TRACKED, because masking is untracked-only', async () => {
    // A committed agent definition is out of scope for masking, so git rescues it. The fixture is a
    // real git work tree with the file committed.
    const repoRoot = path.join(storageRoot, USER_ID, REPO_ID);
    await writeFile(path.join(repoRoot, PERSONA), '---\nname: p\n---\n\nbody\n');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['-C', repoRoot, 'init', '-q']);
    await run('git', ['-C', repoRoot, 'config', 'user.email', 't@example.com']);
    await run('git', ['-C', repoRoot, 'config', 'user.name', 'T']);
    await run('git', ['-C', repoRoot, 'config', 'gc.auto', '0']);
    await run('git', ['-C', repoRoot, 'add', '-A']);
    await run('git', ['-C', repoRoot, 'commit', '-qm', 'seed']);

    const { db } = fakeDb(taskRow, repoRow({ secretMaskDenyExtend: ['**/*.md'] }));
    await expect(
      assertPastedPersonasStillAllowed(db, TASK_ID, null, [PERSONA]),
    ).resolves.toBeUndefined();
  });

  it('allows everything when masking is off globally or for the repository', async () => {
    // Nothing is hidden from the run, so nothing pasted can be a leak.
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const off = fakeDb(taskRow, repoRow({ secretMaskDenyExtend: ['**/*.md'] }));
    await expect(
      assertPastedPersonasStillAllowed(off.db, TASK_ID, null, [PERSONA]),
    ).resolves.toBeUndefined();
    // Global off short-circuits before either lookup.
    expect(off.queries).toEqual([]);

    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const perRepo = fakeDb(
      taskRow,
      repoRow({ secretMaskEnabled: false, secretMaskDenyExtend: ['**/*.md'] }),
    );
    await expect(
      assertPastedPersonasStillAllowed(perRepo.db, TASK_ID, null, [PERSONA]),
    ).resolves.toBeUndefined();
  });

  it('fails CLOSED when the task or repository row cannot be resolved', async () => {
    // Unlike the agent-definition mask beside it, this one refuses rather than waving paths through:
    // a body already in a prompt cannot be retracted.
    await expect(
      assertPastedPersonasStillAllowed(fakeDb(undefined, repoRow()).db, TASK_ID, null, [PERSONA]),
    ).rejects.toThrow(SecretMaskError);
    await expect(
      assertPastedPersonasStillAllowed(fakeDb(taskRow, undefined).db, TASK_ID, null, [PERSONA]),
    ).rejects.toThrow(SecretMaskError);
  });

  it('allows a repo-less task, which mounts no tree at all', async () => {
    const { db } = fakeDb({ userId: USER_ID, repositoryId: null }, repoRow());
    await expect(
      assertPastedPersonasStillAllowed(db, TASK_ID, null, [PERSONA]),
    ).resolves.toBeUndefined();
  });
});

/**
 * The function above is only ever reached through ONE call site, and nothing else in the suite
 * crosses that boundary: MEASURED by removing the call, after which 252 of 252 tests still passed
 * and the only thing that objected was an unused-import error from tsc. That is the same shape as
 * the defect this recheck exists to fix — a guarantee written down and never enforced — so the wiring
 * gets a guard of its own.
 *
 * A STRUCTURAL assertion, not an execution one, and worth naming as the proxy it is: driving
 * `executeByKind` far enough to observe the call needs provider rows, secrets, an image and a
 * spawner. This reads the source instead and pins the two properties that matter — the call is there
 * with the recorded paths, and it precedes `executeCliSpec` so a refusal starts no container. Same
 * shape as the "only 06_5 and 09_5 match promptNamesAgentPath" guard: a change fails the test and
 * becomes a conscious decision.
 */
describe('the exec-core call site', () => {
  it('rechecks the pasted paths BEFORE executeCliSpec runs', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/queues/cli-exec/exec-core.ts', import.meta.url),
      'utf8',
    );

    const call = source.indexOf('await assertPastedPersonasStillAllowed(');
    expect(call).toBeGreaterThan(-1);
    // The recorded paths, not some other argument.
    expect(source.slice(call, call + 400)).toContain('pastedPersonaPaths');

    // Ordering is the load-bearing half: after executeCliSpec the container has already started and
    // the prompt has already been sent, so a refusal there would protect nothing.
    const exec = source.indexOf('return await executeCliSpec(');
    expect(exec).toBeGreaterThan(-1);
    expect(call).toBeLessThan(exec);
  });
});
