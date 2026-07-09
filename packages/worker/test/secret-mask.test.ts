import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_MASK_LIMIT } from '@haive/shared';
import { computeSecretMasks, SecretMaskError } from '../src/queues/cli-exec/secret-mask.js';

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/** Set of containerPaths from the returned masks. */
const maskPaths = (masks: { containerPath: string }[]): Set<string> =>
  new Set(masks.map((m) => m.containerPath));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'haive-secret-mask-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A repo with a COMMITTED secret plus a linked worktree at the path
 *  01-worktree-setup uses. Returns the worktree path. */
async function seedRepoWithWorktree(): Promise<string> {
  await run('git', ['init', '-q', '-b', 'main'], root);
  await run('git', ['config', 'user.email', 'test@haive.local'], root);
  await run('git', ['config', 'user.name', 'test'], root);
  await writeFile(path.join(root, 'committed.key'), 'COMMITTED\n');
  await run('git', ['add', '-A'], root);
  await run('git', ['commit', '-qm', 'seed'], root);
  const wt = path.join(root, '.haive', 'worktrees', 'feature-x');
  await run('git', ['worktree', 'add', '-q', wt, '-b', 'feature/x'], root);
  return wt;
}

describe('computeSecretMasks', () => {
  it('masks untracked secret files; keeps carve-outs, migrations, and code readable', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=1\n');
    await writeFile(path.join(root, '.env.example'), 'SECRET=\n');
    await writeFile(path.join(root, 'id_rsa'), 'PRIVATE KEY\n');
    await writeFile(path.join(root, 'config.pem'), 'CERT\n');
    await writeFile(path.join(root, 'settings.local.php'), '<?php $db = "secret";\n');
    await writeFile(path.join(root, 'dump.sql'), 'INSERT INTO ...\n');
    await mkdir(path.join(root, 'migrations'), { recursive: true });
    await writeFile(path.join(root, 'migrations', '0001_init.sql'), 'CREATE TABLE ...\n');
    await writeFile(path.join(root, 'app.ts'), 'export const x = 1;\n');

    const p = maskPaths(await computeSecretMasks(root, {}, '/work'));

    // secrets masked
    expect(p.has('/work/.env')).toBe(true);
    expect(p.has('/work/id_rsa')).toBe(true);
    expect(p.has('/work/config.pem')).toBe(true);
    expect(p.has('/work/settings.local.php')).toBe(true);
    expect(p.has('/work/dump.sql')).toBe(true);

    // carve-out + migration SQL + normal code stay readable
    expect(p.has('/work/.env.example')).toBe(false);
    expect(p.has('/work/migrations/0001_init.sql')).toBe(false);
    expect(p.has('/work/app.ts')).toBe(false);
  });

  it('produces empty read-only mask content', async () => {
    await writeFile(path.join(root, '.env'), 'SECRET=1\n');
    const masks = await computeSecretMasks(root, {}, '/work');
    expect(masks.length).toBeGreaterThan(0);
    expect(masks.every((m) => m.content === '')).toBe(true);
  });

  it('does not mask tracked (committed) files; only untracked', async () => {
    await run('git', ['init', '-q'], root);
    await run('git', ['config', 'user.email', 'test@haive.local'], root);
    await run('git', ['config', 'user.name', 'test'], root);
    await writeFile(path.join(root, '.env'), 'SECRET=1\n');
    await run('git', ['add', '.env'], root);
    await run('git', ['commit', '-qm', 'commit env'], root);
    await writeFile(path.join(root, 'extra.pem'), 'CERT\n'); // untracked

    const p = maskPaths(await computeSecretMasks(root, {}, '/work'));
    expect(p.has('/work/.env')).toBe(false); // tracked -> not masked (Tier 1)
    expect(p.has('/work/extra.pem')).toBe(true); // untracked -> masked
  });

  // The agent's cwd is the linked worktree, not the repo root, so coverage there is
  // what actually protects anything. The deny globs are `**/`-prefixed and .haive is
  // not in SECRET_SCAN_IGNORE_DIRS, so the scan descends into it.
  it('masks untracked secrets inside a linked worktree', async () => {
    const wt = await seedRepoWithWorktree();
    await writeFile(path.join(wt, '.env'), 'WORKTREE=1\n');
    await mkdir(path.join(wt, '.ddev', 'traefik', 'certs'), { recursive: true });
    await writeFile(path.join(wt, '.ddev', 'traefik', 'certs', 'proj.key'), 'PRIVKEY\n');
    await mkdir(path.join(wt, 'vendor', 'x'), { recursive: true });
    await writeFile(path.join(wt, 'vendor', 'x', 'fixture.key'), 'VENDOR\n');

    const p = maskPaths(await computeSecretMasks(root, {}, '/work'));
    expect(p.has('/work/.haive/worktrees/feature-x/.env')).toBe(true);
    expect(p.has('/work/.haive/worktrees/feature-x/.ddev/traefik/certs/proj.key')).toBe(true);
    // vendor/ is a structural ignore dir, inside the worktree too.
    expect(p.has('/work/.haive/worktrees/feature-x/vendor/x/fixture.key')).toBe(false);
  });

  // `git ls-files` at the repo root lists `committed.key`, never
  // `.haive/worktrees/<name>/committed.key`, so the worktree copy used to be
  // classified untracked and masked — while the identical parent copy stayed
  // readable. No protection, and an empty file under any build that reads it.
  it('does not mask a committed file inside a linked worktree', async () => {
    const wt = await seedRepoWithWorktree();
    const p = maskPaths(await computeSecretMasks(root, {}, '/work'));
    expect(p.has('/work/committed.key')).toBe(false); // parent copy: tracked
    expect(p.has('/work/.haive/worktrees/feature-x/committed.key')).toBe(false); // worktree copy
    expect(wt.endsWith('feature-x')).toBe(true);
  });

  // Masking an arbitrary subset would leave the rest readable — the exact outcome the
  // deny-list exists to prevent. Fail closed instead of truncating silently.
  it('refuses the invocation when matches exceed the cap', async () => {
    const dir = path.join(root, 'certs');
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: SECRET_MASK_LIMIT + 1 }, (_, i) =>
        writeFile(path.join(dir, `.env.${i}`), 'S\n'),
      ),
    );

    const err = await computeSecretMasks(root, {}, '/work').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain(`${SECRET_MASK_LIMIT + 1}`);
    // The heaviest directory is named, since the fix is an allow glob over it.
    expect((err as Error).message).toContain('certs');
  });

  it('emits masks in a deterministic order', async () => {
    await writeFile(path.join(root, 'b.pem'), 'B\n');
    await writeFile(path.join(root, 'a.pem'), 'A\n');
    await writeFile(path.join(root, '.env'), 'E\n');

    const paths = (await computeSecretMasks(root, {}, '/work')).map((m) => m.containerPath);
    expect(paths).toEqual([...paths].sort());
  });

  it('allow un-masks a file and denyExtend masks extra globs', async () => {
    await writeFile(path.join(root, '.env'), 'X\n');
    await writeFile(path.join(root, 'data.sql'), 'CREATE TABLE ...\n');
    await mkdir(path.join(root, 'migrations'), { recursive: true });
    await writeFile(path.join(root, 'migrations', '0001_init.sql'), 'CREATE TABLE ...\n');

    // baseline: .env masked, bare .sql readable
    const base = maskPaths(await computeSecretMasks(root, {}, '/work'));
    expect(base.has('/work/.env')).toBe(true);
    expect(base.has('/work/data.sql')).toBe(false);

    // allow un-masks .env; denyExtend masks all .sql incl. the migration
    const p = maskPaths(
      await computeSecretMasks(root, { allow: ['**/.env'], denyExtend: ['**/*.sql'] }, '/work'),
    );
    expect(p.has('/work/.env')).toBe(false);
    expect(p.has('/work/data.sql')).toBe(true);
    expect(p.has('/work/migrations/0001_init.sql')).toBe(true);
  });

  it('ignores structural dirs (node_modules, .git)', async () => {
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', '.env'), 'VENDOR=1\n');
    await writeFile(path.join(root, '.env'), 'REAL=1\n');

    const p = maskPaths(await computeSecretMasks(root, {}, '/work'));
    expect(p.has('/work/.env')).toBe(true);
    expect(p.has('/work/node_modules/pkg/.env')).toBe(false);
  });
});
