import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  const { rememberReroute: remember } = await restoreKbReroutes(repo, 'task');
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
  const { rememberReroute: remember } = await restoreKbReroutes(repo, 'task');
  await remember('a.md', '# Original');
  await writeFile(path.join(repo, 'README.md'), '# Project');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  expect(
    execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }),
  ).toBe('README.md\n');
});

it.each([
  'directory file',
  'directory symlink',
  'malformed JSON',
  'schema mismatch',
  'invalid path',
  'KB directory',
  'journal directory',
  'journal symlink',
])('Retry completes and retains drafts and bytes with a planted %s', async (shape) => {
  const recovery = path.join(repo, '.haive/kb-reroute-recovery');
  const journal = path.join(recovery, `${createHash('sha256').update('t1').digest('hex')}.json`);
  const kb = path.join(repo, '.haive-data/knowledge_base');
  await mkdir(path.join(kb, 'ANTI_PATTERNS'), { recursive: true });
  const body = '# Local original\n\nUse public Drupal APIs.\n';
  await writeFile(path.join(kb, 'ANTI_PATTERNS/a.md'), body);
  await mkdir(path.join(repo, '.haive'), { recursive: true });
  const sentinel = path.join(repo, 'sentinel');
  await writeFile(sentinel, 'private sentinel');
  if (shape === 'directory file') await writeFile(recovery, 'private sentinel');
  else if (shape === 'directory symlink') await symlink(sentinel, recovery);
  else {
    await mkdir(recovery);
    if (shape === 'journal directory') await mkdir(journal);
    else if (shape === 'journal symlink') await symlink(sentinel, journal);
    else if (shape === 'malformed JSON') await writeFile(journal, '{private sentinel');
    else if (shape === 'schema mismatch') await writeFile(journal, '{"private sentinel":true}');
    else {
      await writeFile(
        journal,
        JSON.stringify({
          version: 1,
          files: [
            {
              path: shape === 'invalid path' ? '../private sentinel.md' : 'blocked.md',
              body: '# Saved original',
            },
          ],
        }),
      );
      if (shape === 'KB directory') await mkdir(path.join(kb, 'blocked.md'));
    }
  }
  const planted = ['malformed JSON', 'schema mismatch', 'invalid path'].includes(shape)
    ? await readFile(journal, 'utf8')
    : null;
  h.drafts.push({ title: 'prior', body: '# Saved original' });
  const context = ctx();
  const warn = vi.spyOn(context.logger, 'warn');
  // First replay has no re-route selected; recovery must never wedge apply.
  await knowledgeAcquisitionStep.apply(context, {
    iteration: 0,
    previousIterations: [],
    detected,
    formValues: { selectedTopics: [], rerouteGlobal: [] },
    llmOutput: { placements: [] },
  });
  expect(h.drafts).toContainEqual({ title: 'prior', body: '# Saved original' });
  expect(await readFile(path.join(kb, 'ANTI_PATTERNS/a.md'), 'utf8')).toBe(body);
  expect(await readFile(sentinel, 'utf8')).toBe('private sentinel');
  expect(warn).toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private sentinel');
  // A journal that cannot be read or validated is never overwritten: it may be the only copy.
  if (['malformed JSON', 'schema mismatch', 'invalid path'].includes(shape))
    expect(await readFile(journal, 'utf8')).toBe(planted);
  // A directory slot that cannot hold a journal must also preserve a selected source.
  if (shape.startsWith('directory ') || shape === 'journal directory') {
    await knowledgeAcquisitionStep.apply(context, {
      iteration: 0,
      previousIterations: [],
      detected,
      formValues: { selectedTopics: [], rerouteGlobal: ['ANTI_PATTERNS/a.md'] },
      llmOutput: {
        placements: [{ path: 'ANTI_PATTERNS/a.md', category: 'anti_pattern', tech: 'drupal' }],
      },
    });
    expect(await readFile(path.join(kb, 'ANTI_PATTERNS/a.md'), 'utf8')).toBe(body);
    expect(h.drafts).toContainEqual({ title: 'prior', body: '# Saved original' });
  }
});
