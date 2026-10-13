import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HAIVE_DATA_FILES } from '@haive/shared';
import {
  PlanMirrorHeldError,
  removePlanJsonIfUnchanged,
  writePlanJsonIfUnchanged,
} from '../src/plan/mirror.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
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
  it('replaces the bytes it last synced', async () => {
    const repo = await repoWith('{"synced":1}\n');
    await writePlanJsonIfUnchanged(repo, '{"next":1}\n', sha('{"synced":1}\n'));
    expect(await onDisk(repo)).toBe('{"next":1}\n');
  });

  it('holds and keeps bytes that arrived after the last sync, judged on the file it replaces', async () => {
    const repo = await repoWith('{"teammate":1}\n');
    await expect(
      writePlanJsonIfUnchanged(repo, '{"next":1}\n', sha('{"synced":1}\n')),
    ).rejects.toBeInstanceOf(PlanMirrorHeldError);
    expect(await onDisk(repo)).toBe('{"teammate":1}\n');
  });

  it('creates the file when none exists', async () => {
    const repo = await repoWith(null);
    await writePlanJsonIfUnchanged(repo, '{"next":1}\n', sha(''));
    expect(await onDisk(repo)).toBe('{"next":1}\n');
  });
});

describe('removePlanJsonIfUnchanged', () => {
  it('removes the bytes it last synced', async () => {
    const repo = await repoWith('{"synced":1}\n');
    await removePlanJsonIfUnchanged(repo, sha('{"synced":1}\n'));
    await expect(access(path.join(repo, HAIVE_DATA_FILES.plan))).rejects.toThrow();
  });

  it('holds and keeps bytes that arrived after the last sync', async () => {
    const repo = await repoWith('{"teammate":1}\n');
    await expect(removePlanJsonIfUnchanged(repo, sha('{"synced":1}\n'))).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
    expect(await onDisk(repo)).toBe('{"teammate":1}\n');
  });

  it('is a no-op when the file is already gone', async () => {
    const repo = await repoWith(null);
    await expect(removePlanJsonIfUnchanged(repo, sha('{"synced":1}\n'))).resolves.toBeUndefined();
  });
});
