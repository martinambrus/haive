// Rule: a new Start entry must run the custom tool gate (markQueuedForStart or the Retry requeue) or be listed here with a reason.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const sourceDirs = ['packages/api/src', 'packages/worker/src', ...modulesSrc()];
// A call, not the definition: `function enqueueStart(`.
const startCalls = /(?<!function\s)\benqueueStart\(/g;
const directStarts = /\.add\(\s*TASK_JOB_NAMES\.START\b/g;
const queuedWrites = /\.set\(\s*\{\s*status:\s*'queued'/g;

function modulesSrc(): string[] {
  const dir = resolve(import.meta.dirname, '../../../modules');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `modules/${e.name}/src`);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

function scan(base: string, dirs: string[], pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = sources(resolve(base, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      const n = [...readFileSync(file, 'utf8').matchAll(pattern)].length;
      if (n > 0) found[relative(base, file)] = n;
    }
  }
  return found;
}

describe('start entry points', () => {
  it('S1: only these files put a START job on the queue', () => {
    const calls = scan(root, sourceDirs, startCalls);
    const adds = scan(root, sourceDirs, directStarts);
    expect(calls).toEqual({
      'packages/api/src/lib/spawn-plan-task.ts': 2,
      'packages/api/src/routes/global-kb.ts': 1,
      'packages/api/src/routes/plan.ts': 2,
      'packages/api/src/routes/task-type-drafts.ts': 1,
      'packages/api/src/routes/tasks/index.ts': 3,
      'packages/api/src/routes/upgrades.ts': 1,
      // Recovery only: re-enqueues a task that is already `queued`, never a `created` one.
      'packages/worker/src/queues/dead-task-boot.ts': 1,
      'packages/worker/src/queues/stalled-redrive.ts': 1,
    });
    expect(adds).toEqual({
      'packages/api/src/lib/task-start.ts': 1,
      'packages/worker/src/queues/task-queue.ts': 1,
    });
  });

  it('S2: only these files write tasks.status to queued', () => {
    expect(scan(root, sourceDirs, queuedWrites)).toEqual({
      'packages/api/src/lib/task-start.ts': 1,
      'packages/api/src/routes/tasks/index.ts': 1,
    });
  });

  it('the scan reports a planted writer', () => {
    const base = mkdtempSync(join(tmpdir(), 'start-entry-'));
    try {
      mkdirSync(join(base, 'src'));
      writeFileSync(
        join(base, 'src/rogue.ts'),
        "await enqueueStart(id, u);\nq.add(TASK_JOB_NAMES.START, {});\ndb.update(t).set({ status: 'queued' });\n",
      );
      expect(scan(base, ['src'], startCalls)).toEqual({ 'src/rogue.ts': 1 });
      expect(scan(base, ['src'], directStarts)).toEqual({ 'src/rogue.ts': 1 });
      expect(scan(base, ['src'], queuedWrites)).toEqual({ 'src/rogue.ts': 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
