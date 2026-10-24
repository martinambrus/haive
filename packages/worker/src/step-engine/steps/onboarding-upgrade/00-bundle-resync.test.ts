import { networkGitArgs } from '../../../../test/support/git-http.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { gitTimeoutLimits } from '../../../repo/git-exec.js';
import { failGit } from '../../../../test/support/fake-git.js';
import { killGit } from '../../../../test/support/kill-git.js';
import { shimGit } from '../../../../test/support/shim-git.js';
import { bundleResyncStep } from './00-bundle-resync.js';

const step = bundleResyncStep as Required<typeof bundleResyncStep>;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'gc.auto=0',
      ...networkGitArgs(args),
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();

interface Fixture {
  id: string;
  name: string;
  bare: string;
  clone: string;
}

const dirs: string[] = [];
let restore: (() => Promise<void>) | null = null;

const savedLimits = { ...gitTimeoutLimits };

afterEach(async () => {
  gitTimeoutLimits.long = savedLimits.long;
  gitTimeoutLimits.short = savedLimits.short;
  if (restore) await restore();
  restore = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeBundle(name: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'bundle-resync-'));
  dirs.push(root);
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, 'init', '--bare', '--initial-branch=main', bare);
  git(root, 'clone', bare, seed);
  git(seed, 'checkout', '-B', 'main');
  await writeFile(path.join(seed, 'a.txt'), 'one');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'one');
  git(seed, 'push', 'origin', 'main');
  git(root, 'clone', '--branch', 'main', bare, clone);
  return { id: `id-${name}`, name, bare, clone };
}

function drift(f: Fixture): void {
  const second = `${f.bare}-second`;
  dirs.push(second);
  git(path.dirname(f.bare), 'clone', f.bare, second);
  git(second, 'checkout', '-B', 'main');
  execFileSync('sh', ['-c', 'echo two > b.txt'], { cwd: second });
  git(second, 'add', '.');
  git(second, 'commit', '-m', 'two');
  git(second, 'push', 'origin', 'main');
}

function ctxFor(fixtures: Fixture[]): StepContext {
  const rows = fixtures.map((f) => ({
    id: f.id,
    name: f.name,
    sourceType: 'git',
    gitBranch: 'main',
    storageRoot: f.clone,
    lastSyncCommit: null,
    status: 'active',
  }));
  let call = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1;
          if (call === 1) return { limit: async () => [{ repositoryId: 'r1' }] };
          return Promise.resolve(rows);
        },
      }),
    }),
  };
  return {
    db,
    taskId: 't1',
    userId: 'u1',
    logger: { info: () => undefined, warn: () => undefined },
  } as unknown as StepContext;
}

const multiSelect = (form: FormSchema | null) =>
  form?.fields.find((f) => f.type === 'multi-select');
const notes = (form: FormSchema | null) => form?.fields.filter((f) => f.type === 'note') ?? [];

describe('00-bundle-resync form', () => {
  it('shows a bundle whose fetch was killed', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    restore = (await killGit(['fetch'])).restore;
    const detected = await step.detect(ctx);
    expect(detected.candidates).toHaveLength(1);
    expect(detected.candidates[0]?.fetchError).toMatch(/git fetch failed \(exit SIGKILL\)/);
    expect(detected.candidates[0]?.hasUpstreamChange).toBe(false);
    const form = step.form(ctx, detected);
    expect(form).not.toBeNull();
    expect(multiSelect(form)).toBeUndefined();
    const found = notes(form);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'fetchFailed', variant: 'warning' });
    const body = (found[0] as { body: string }).body;
    expect(body).toContain('alpha');
    expect(body).toContain('git fetch failed');

    const out = await step.apply(ctx, {
      detected,
      formValues: {},
    } as Parameters<typeof step.apply>[1]);
    expect(out).toEqual({ resyncedBundleIds: [], warnings: [] });
  });

  it('shows a bundle whose fetch exited non-zero', async () => {
    const a = await makeBundle('alpha');
    git(a.clone, 'remote', 'set-url', 'origin', path.join(path.dirname(a.bare), 'missing.git'));
    const ctx = ctxFor([a]);
    const detected = await step.detect(ctx);
    expect(detected.candidates[0]?.fetchError).toMatch(/exit 128/);
    const form = step.form(ctx, detected);
    expect(form).not.toBeNull();
    expect(multiSelect(form)).toBeUndefined();
    expect(notes(form)).toHaveLength(1);
    expect(notes(form)[0]).toMatchObject({ id: 'fetchFailed', variant: 'warning' });
  });

  it('lists the drifted bundle and names only the failing one', async () => {
    const a = await makeBundle('alpha');
    const b = await makeBundle('beta');
    drift(a);
    git(b.clone, 'remote', 'set-url', 'origin', path.join(path.dirname(b.bare), 'missing.git'));
    const ctx = ctxFor([a, b]);
    const detected = await step.detect(ctx);
    const form = step.form(ctx, detected);
    const select = multiSelect(form) as { options: { value: string }[]; defaults: string[] };
    expect(select.options.map((o) => o.value)).toEqual([a.id]);
    expect(select.defaults).toEqual([a.id]);
    const found = notes(form);
    expect(found).toHaveLength(1);
    const body = (found[0] as { body: string }).body;
    expect(body).toContain('**beta**');
    expect(body).not.toContain('alpha');
  });

  it('is null when every bundle is healthy and none drifted', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    const detected = await step.detect(ctx);
    expect(step.form(ctx, detected)).toBeNull();
  });

  it('shows only the multi-select for a drifted bundle with no failure', async () => {
    const a = await makeBundle('alpha');
    drift(a);
    const ctx = ctxFor([a]);
    const detected = await step.detect(ctx);
    const form = step.form(ctx, detected);
    const select = multiSelect(form) as { defaults: string[] };
    expect(select.defaults).toEqual([a.id]);
    expect(notes(form)).toHaveLength(0);
  });
});

describe('00-bundle-resync git bounds', () => {
  it('shows a bundle whose fetch hangs', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    gitTimeoutLimits.long = 300;
    restore = (await failGit(['fetch'], { hang: true })).restore;
    const detected = await step.detect(ctx);
    expect(detected.candidates[0]?.fetchError).toMatch(/git fetch failed \(exit 124\)/);
    expect(detected.candidates[0]?.fetchError).toMatch(/timed out/);
    expect(detected.candidates[0]?.hasUpstreamChange).toBe(false);
  }, 10_000);

  it('shows a bundle whose rev-parse of the remote head hangs', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    gitTimeoutLimits.short = 300;
    restore = (await failGit(['rev-parse', 'origin/main'], { hang: true })).restore;
    const detected = await step.detect(ctx);
    expect(detected.candidates[0]?.fetchError).toMatch(
      /git rev-parse origin\/main failed \(exit 124\)/,
    );
  }, 10_000);

  it('scrubs a url from a failed fetch', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    restore = (
      await shimGit(
        `if [ "$SUB" = fetch ]; then echo "fatal: unable to access 'https://user:s3cret@example.com/r.git/': boom" >&2; exit 128; fi\nexec "$REAL_GIT" "$@"`,
      )
    ).restore;
    const detected = await step.detect(ctx);
    const err = detected.candidates[0]?.fetchError ?? '';
    expect(err).toMatch(/git fetch failed \(exit 128\)/);
    expect(err).toContain('https://***@');
    expect(err).not.toContain('s3cret');
  });

  it('runs the fetch with askpass echo and no prompt', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    const seen = path.join(path.dirname(a.bare), 'seen');
    restore = (
      await shimGit(
        `if [ "$SUB" = fetch ]; then echo "$GIT_ASKPASS $GIT_TERMINAL_PROMPT" >> '${seen}'; fi\nexec "$REAL_GIT" "$@"`,
      )
    ).restore;
    await step.detect(ctx);
    expect((await readFile(seen, 'utf8')).trim()).toBe('echo 0');
  });
});

describe('00-bundle-resync local head read', () => {
  it('shows a bundle whose local head read was killed', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    restore = (await killGit(['rev-parse', 'HEAD'])).restore;
    const detected = await step.detect(ctx);
    expect(detected.candidates[0]?.fetchError).toMatch(
      /could not read the local head: git rev-parse failed/,
    );
    expect(detected.candidates[0]?.hasUpstreamChange).toBe(false);
    const form = step.form(ctx, detected);
    expect(form).not.toBeNull();
    const found = notes(form);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'fetchFailed' });
    const body = (found[0] as { body: string }).body;
    expect(body).toContain('alpha');
    expect(body).toContain('could not read the local head');
  });

  it('shows a bundle whose local head read exited non-zero', async () => {
    const a = await makeBundle('alpha');
    const ctx = ctxFor([a]);
    restore = (await failGit(['rev-parse', 'HEAD'], { exit: 128 })).restore;
    const detected = await step.detect(ctx);
    expect(detected.candidates[0]?.fetchError).toMatch(/could not read the local head/);
    expect(detected.candidates[0]?.fetchError).toMatch(/exit 128/);
  });

  it('keeps the fetch error when the local head read fails too', async () => {
    const a = await makeBundle('alpha');
    git(a.clone, 'remote', 'set-url', 'origin', path.join(path.dirname(a.bare), 'missing.git'));
    const ctx = ctxFor([a]);
    restore = (await failGit(['rev-parse', 'HEAD'], { exit: 128 })).restore;
    const detected = await step.detect(ctx);
    expect(detected.candidates[0]?.fetchError).toMatch(/git fetch failed/);
    expect(detected.candidates[0]?.fetchError).not.toMatch(/local head/);
  });

  it('returns no hasAny key', async () => {
    const a = await makeBundle('alpha');
    const clean = await step.detect(ctxFor([a]));
    expect(clean).not.toHaveProperty('hasAny');
    const b = await makeBundle('beta');
    drift(b);
    const drifted = await step.detect(ctxFor([b]));
    expect(drifted.candidates[0]?.hasUpstreamChange).toBe(true);
    expect(drifted).not.toHaveProperty('hasAny');
  });
});
