import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { schema } from '@haive/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { ragPopulateStep } from '../src/step-engine/steps/onboarding/10-rag-populate.js';

let root: string;
let scope: string[] | null;
let envDetect: unknown;

async function write(rel: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, 'function x() { return 1; }\n', 'utf8');
}

function context(): StepContext {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => [{ globs: scope }] }),
        }),
        where: () => ({
          orderBy: () => ({
            limit: async () =>
              table === schema.taskSteps && envDetect
                ? [{ detectOutput: envDetect, round: 0 }]
                : [],
          }),
          limit: async () => [],
        }),
      }),
    }),
  };
  return {
    db,
    taskId: 'task-1',
    taskStepId: 'step-1',
    repoPath: root,
    workspacePath: root,
    emitProgress: async () => {},
    throwIfCancelled: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as StepContext;
}

const codePaths = async () =>
  (await ragPopulateStep.detect!(context())).codeFiles.map((f) => f.relPath);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'haive-rag-detect-scope-'));
  envDetect = {
    data: {
      paths: {
        customCodePaths: {
          exclude: ['wp-content/plugins/', 'vendor-ui/'],
          include: ['wp-content/plugins/acme/'],
        },
      },
    },
  };
  await write('src/a.php');
  await write('vendor-ui/w.php');
  await write('wp-content/plugins/acme/acme.php');
  await write('wp-content/plugins/other/o.php');
  await write('docs/d.php');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('10-rag-populate detect scope', () => {
  it('applies the env-detect heuristic when no scope is saved, but keeps an own path', async () => {
    scope = null;

    expect(await codePaths()).toEqual([
      'docs/d.php',
      'src/a.php',
      'wp-content/plugins/acme/acme.php',
    ]);
  });

  it('drops the heuristic once a scope is saved, as the workflow sync does', async () => {
    scope = ['docs'];

    expect(await codePaths()).toEqual([
      'src/a.php',
      'vendor-ui/w.php',
      'wp-content/plugins/acme/acme.php',
      'wp-content/plugins/other/o.php',
    ]);
  });

  it('keeps a user-denied own path out', async () => {
    scope = ['wp-content/plugins/acme'];

    expect(await codePaths()).not.toContain('wp-content/plugins/acme/acme.php');
  });
});
