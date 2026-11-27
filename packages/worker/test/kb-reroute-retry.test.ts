import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { GlobalKbDeadlineError } from '@haive/shared/global-kb';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ promote: vi.fn(), drafts: [] as { title: string; body: string }[] }));

vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-promote.js')>();
  return {
    ...actual,
    clearTaskPromotedDrafts: async () => {
      h.drafts.splice(0);
      return 0;
    },
    promoteToGlobalKbDraft: h.promote,
  };
});

import { knowledgeAcquisitionStep } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

type Detected = Parameters<typeof knowledgeAcquisitionStep.apply>[1]['detected'];

const detected = {
  framework: 'drupal',
  frameworkMajor: '11',
  language: 'php',
  projectName: 'siteray',
  phpMajor: '8',
  nodeMajor: null,
  database: null,
  dbMajor: null,
  packages: [],
  customCode: { include: [], exclude: [] },
} as unknown as Detected;

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-description-'));
  h.promote.mockReset();
  h.drafts.splice(0);
  h.promote.mockResolvedValue({ id: 'promoted-1', deduped: false });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

function ctx(): StepContext {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  return {
    taskId: 't1',
    taskStepId: 'ts1',
    userId: 'u1',
    repoPath: repo,
    workspacePath: repo,
    cliProviderId: null,
    db: { select: () => chain } as unknown as Database,
    logger: logger.child({ test: 'kb-global-description' }),
    emitProgress: async () => {},
    sandboxWorkdir: '/haive/workdir',
    round: 0,
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
  };
}

it.each(['next promotion', 'later work', 'unknown outcome'])(
  'restores re-routed files before Retry purges drafts after failure in %s',
  async (failure) => {
    const paths = ['ANTI_PATTERNS/a.md', 'ANTI_PATTERNS/b.md'];
    const bodies = paths.map((p) => `# ${p}\n\nUse public Drupal APIs.\n`);
    await mkdir(path.join(repo, '.haive-data/knowledge_base/ANTI_PATTERNS'), { recursive: true });
    for (const [i, p] of paths.entries())
      await writeFile(path.join(repo, '.haive-data/knowledge_base', p), bodies[i]!);
    let fail = true;
    h.promote.mockImplementation(async (_db, p) => {
      h.drafts.push({ title: p.title, body: p.body });
      if (fail && p.title.includes('b.md') && failure !== 'later work') {
        if (failure !== 'unknown outcome') h.drafts.pop();
        throw new GlobalKbDeadlineError(12);
      }
      return { id: p.title, deduped: false };
    });
    const context = ctx();
    context.throwIfCancelled = () => {
      if (fail && failure === 'later work') throw new Error('later apply failure');
    };
    const args = {
      iteration: 0,
      previousIterations: [],
      detected,
      formValues: { selectedTopics: [], rerouteGlobal: paths },
      llmOutput: {
        placements: paths.map((p) => ({ path: p, category: 'anti_pattern', tech: 'drupal' })),
      },
    };
    await expect(knowledgeAcquisitionStep.apply(context, args)).rejects.toThrow();
    fail = false;
    // Retry may fail immediately after its purge; every file still needs a live copy then.
    context.throwIfCancelled = () => {
      throw new Error('retry later failure');
    };
    await expect(knowledgeAcquisitionStep.apply(context, args)).rejects.toThrow();
    for (const [i, p] of paths.entries()) {
      const local = await readFile(path.join(repo, '.haive-data/knowledge_base', p), 'utf8').catch(
        () => null,
      );
      expect(
        local === bodies[i] || h.drafts.some((d) => d.title === p && d.body === bodies[i]),
        `lost ${p} after Retry`,
      ).toBe(true);
    }
    context.throwIfCancelled = () => {};
    await knowledgeAcquisitionStep.apply(context, args);
    expect(h.drafts.map((d) => d.body).sort()).toEqual([...bodies].sort());
    expect(h.drafts).toHaveLength(2);
  },
);

it('preserves a newer local file when replaying the recovery journal', async () => {
  const { restoreKbReroutes } =
    await import('../src/step-engine/steps/onboarding/_kb-reroute-recovery.js');
  const remember = await restoreKbReroutes(repo, 'task');
  await remember('a.md', '# Original');
  await mkdir(path.join(repo, '.haive-data/knowledge_base'), { recursive: true });
  await writeFile(path.join(repo, '.haive-data/knowledge_base/a.md'), '# Newer local edit');
  await restoreKbReroutes(repo, 'task');
  expect(await readFile(path.join(repo, '.haive-data/knowledge_base/a.md'), 'utf8')).toBe(
    '# Newer local edit',
  );
});

it('keeps recovery bodies out of a full-tree onboarding Git stage', async () => {
  const { restoreKbReroutes } =
    await import('../src/step-engine/steps/onboarding/_kb-reroute-recovery.js');
  const remember = await restoreKbReroutes(repo, 'task');
  await remember('a.md', '# Original');
  await writeFile(path.join(repo, 'README.md'), '# Project');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  expect(
    execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }),
  ).toBe('README.md\n');
});
