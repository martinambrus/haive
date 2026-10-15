import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// pruneJobSchedulers deletes at every boot each scheduler its queue's keep list does not name, so
// a new upsertJobScheduler call adds its id to that queue's keep list, then its count here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const CALL_SITES: Record<string, number> = {
  'packages/worker/src/queues/bundle-queue.ts': 1,
  'packages/worker/src/queues/cli-exec/handlers.ts': 1,
  'packages/worker/src/queues/global-kb-sync-queue.ts': 2,
  'packages/worker/src/queues/plan-mirror-queue.ts': 1,
  'packages/worker/src/queues/pr-poll-queue.ts': 1,
  'packages/worker/src/queues/usage-poll-queue.ts': 1,
};

function scanRoots(): string[] {
  const modules = readdirSync(path.join(REPO_ROOT, 'modules'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(REPO_ROOT, 'modules', e.name, 'src')))
    .map((e) => `modules/${e.name}/src`);
  return ['packages/api/src', 'packages/worker/src', 'packages/shared/src', ...modules];
}

function sources(rel: string): string[] {
  return readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true }).flatMap((e) => {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) return sources(child);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [child] : [];
  });
}

describe('job scheduler call sites', () => {
  it('names every upsertJobScheduler call, each in a file that prunes its queue', () => {
    const found: Record<string, number> = {};
    const unpruned: string[] = [];
    for (const rel of scanRoots().flatMap(sources)) {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const calls = text.split('.upsertJobScheduler(').length - 1;
      if (calls === 0) continue;
      found[rel] = calls;
      if (!text.includes('pruneJobSchedulers(')) unpruned.push(rel);
    }
    expect(found).toEqual(CALL_SITES);
    expect(unpruned).toEqual([]);
  });
});
