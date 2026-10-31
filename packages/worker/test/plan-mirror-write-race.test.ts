import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HAIVE_DATA_FILES } from '@haive/shared';
import {
  PlanMirrorHeldError,
  removePlanJsonIfUnchanged,
  writePlanJsonIfUnchanged,
} from '../src/plan/mirror.js';

const b = (text: string) => Buffer.from(text, 'utf8');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repoWith(planJson: string | null): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'plan-write-race-'));
  dirs.push(repo);
  if (planJson !== null) {
    await mkdir(path.dirname(path.join(repo, HAIVE_DATA_FILES.plan)), { recursive: true });
    await writeFile(path.join(repo, HAIVE_DATA_FILES.plan), planJson, 'utf8');
  }
  return repo;
}

const onDisk = (repo: string) => readFile(path.join(repo, HAIVE_DATA_FILES.plan), 'utf8');

describe('writePlanJsonIfUnchanged', () => {
  it('replaces the bytes it judged', async () => {
    const repo = await repoWith('{"synced":1}\n');
    await writePlanJsonIfUnchanged(repo, '{"next":1}\n', b('{"synced":1}\n'));
    expect(await onDisk(repo)).toBe('{"next":1}\n');
  });

  it('holds and keeps bytes that landed after the flush judged the file', async () => {
    const repo = await repoWith('{"teammate":1}\n');
    await expect(
      writePlanJsonIfUnchanged(repo, '{"next":1}\n', b('{"synced":1}\n')),
    ).rejects.toBeInstanceOf(PlanMirrorHeldError);
    expect(await onDisk(repo)).toBe('{"teammate":1}\n');
  });

  it('creates the file when none exists', async () => {
    const repo = await repoWith(null);
    await writePlanJsonIfUnchanged(repo, '{"next":1}\n', null);
    expect(await onDisk(repo)).toBe('{"next":1}\n');
  });
});

describe('removePlanJsonIfUnchanged', () => {
  it('removes the bytes it judged', async () => {
    const repo = await repoWith('{"synced":1}\n');
    await removePlanJsonIfUnchanged(repo, b('{"synced":1}\n'));
    await expect(access(path.join(repo, HAIVE_DATA_FILES.plan))).rejects.toThrow();
  });

  it('holds and keeps bytes that landed after the flush judged the file', async () => {
    const repo = await repoWith('{"teammate":1}\n');
    await expect(removePlanJsonIfUnchanged(repo, b('{"synced":1}\n'))).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
    expect(await onDisk(repo)).toBe('{"teammate":1}\n');
  });

  it('is a no-op when the file is already gone', async () => {
    const repo = await repoWith(null);
    await expect(removePlanJsonIfUnchanged(repo, b('{"synced":1}\n'))).resolves.toBeUndefined();
  });
});

describe('a merge open when the file is judged', () => {
  // The hold is told by its code, never by the sentence shown to the person.
  const heldByOperation = { name: 'PlanMirrorHeldError', code: 'git_operation' };

  it('holds the write and the removal and keeps the bytes', async () => {
    const repo = await repoWith('{"synced":1}\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(path.join(repo, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n');
    await expect(
      writePlanJsonIfUnchanged(repo, '{"next":1}\n', b('{"synced":1}\n')),
    ).rejects.toMatchObject(heldByOperation);
    await expect(removePlanJsonIfUnchanged(repo, b('{"synced":1}\n'))).rejects.toMatchObject(
      heldByOperation,
    );
    expect(await onDisk(repo)).toBe('{"synced":1}\n');
  });

  it('holds creating or removing an absent plan.json too', async () => {
    const repo = await repoWith(null);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(path.join(repo, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n');
    await expect(writePlanJsonIfUnchanged(repo, '{"next":1}\n', null)).rejects.toMatchObject(
      heldByOperation,
    );
    await expect(removePlanJsonIfUnchanged(repo, null)).rejects.toMatchObject(heldByOperation);
    await expect(access(path.join(repo, HAIVE_DATA_FILES.plan))).rejects.toThrow();
  });
});

describe('bytes that decode alike', () => {
  it('holds when malformed bytes read as the U+FFFD the synced file held', async () => {
    const synced = '{"t":"\uFFFD"}\n';
    const repo = await repoWith(null);
    await mkdir(path.dirname(path.join(repo, HAIVE_DATA_FILES.plan)), { recursive: true });
    const malformed = Buffer.concat([
      Buffer.from('{"t":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]);
    await writeFile(path.join(repo, HAIVE_DATA_FILES.plan), malformed);
    expect(malformed.toString('utf8')).toBe(synced);
    await expect(writePlanJsonIfUnchanged(repo, '{"next":1}\n', b(synced))).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
    expect(await readFile(path.join(repo, HAIVE_DATA_FILES.plan))).toEqual(malformed);
  });
});

describe('a plan.json past the cap', () => {
  it('is held without being read in', async () => {
    const repo = await repoWith('{"synced":1}\n');
    await truncate(path.join(repo, HAIVE_DATA_FILES.plan), 17 * 1024 * 1024);
    await expect(
      writePlanJsonIfUnchanged(repo, '{"next":1}\n', b('{"synced":1}\n')),
    ).rejects.toBeInstanceOf(PlanMirrorHeldError);
    await expect(removePlanJsonIfUnchanged(repo, b('{"synced":1}\n'))).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
  });
});

describe('an empty plan.json', () => {
  it('is never taken for the absence an older row stamped as the hash of zero bytes', async () => {
    const repo = await repoWith('');
    await expect(writePlanJsonIfUnchanged(repo, '{"next":1}\n', null)).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
    await expect(removePlanJsonIfUnchanged(repo, null)).rejects.toBeInstanceOf(PlanMirrorHeldError);
    expect(await onDisk(repo)).toBe('');
  });
});

describe('a render past the cap', () => {
  it('is never written, since no later read could judge it', async () => {
    const repo = await repoWith(null);
    const huge = `{"t":"${'x'.repeat(16 * 1024 * 1024)}"}\n`;
    await expect(writePlanJsonIfUnchanged(repo, huge, null)).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
    await expect(access(path.join(repo, HAIVE_DATA_FILES.plan))).rejects.toThrow();
  });
});
