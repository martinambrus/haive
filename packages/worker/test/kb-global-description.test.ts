import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ promote: vi.fn() }));

vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-promote.js')>();
  return { ...actual, clearTaskPromotedDrafts: async () => 0, promoteToGlobalKbDraft: h.promote };
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

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'no-inline-svg',
  title: 'No inline SVG',
  category: 'anti_pattern',
  tech: 'drupal',
  scope: 'global',
  sections: [
    { heading: 'The wrong way', body: 'Inline markup is copied into every cache entry.' },
    { heading: 'The right way', body: 'Reference a file instead.' },
  ],
  ...over,
});

const apply = (llmOutput: unknown, formValues: Record<string, unknown> = {}) =>
  knowledgeAcquisitionStep.apply(ctx(), {
    iteration: 0,
    previousIterations: [],
    detected,
    formValues: { selectedTopics: ['no-inline-svg'], ...formValues },
    llmOutput,
  });

describe('08 global entries and descriptions', () => {
  it('passes a global entry its description to the promotion', async () => {
    const out = await apply({
      entries: [entry({ description: 'Inline markup is copied into every cache entry.' })],
    });

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote.mock.calls[0]![1]).toMatchObject({
      title: 'No inline SVG',
      description: 'Inline markup is copied into every cache entry.',
    });
    expect(out.globalPromoted).toBe(1);
  });

  it('keeps it for an entry whose body the agent staged in a file, the form the prompt asks for', async () => {
    const draftDir = path.join(repo, '.haive', 'kb-draft');
    await mkdir(draftDir, { recursive: true });
    await writeFile(
      path.join(draftDir, 'no-inline-svg.md'),
      '## The wrong way\n\nInline markup is copied into every cache entry.\n\n## The right way\n\nReference a file instead.\n',
    );
    const { sections: _inline, ...staged } = entry({
      description: 'Inline markup is copied into every cache entry.',
      bodyPath: '.haive/kb-draft/no-inline-svg.md',
    });

    await apply({ entries: [staged] });

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote.mock.calls[0]![1]).toMatchObject({
      description: 'Inline markup is copied into every cache entry.',
    });
  });

  it('promotes an entry that has none, or one that is not a string, with no description', async () => {
    for (const description of [undefined, 42, { text: 'x' }]) {
      h.promote.mockClear();
      await apply({ entries: [entry({ description })] });
      expect(h.promote).toHaveBeenCalledTimes(1);
      expect(h.promote.mock.calls[0]![1].description).toBeUndefined();
    }
  });

  it('describes a re-routed existing file with nothing, since no model wrote a line for it', async () => {
    const kb = path.join(repo, '.haive-data', 'knowledge_base', 'ANTI_PATTERNS');
    await mkdir(kb, { recursive: true });
    await writeFile(
      path.join(kb, 'drupal-mistakes.md'),
      '# Drupal mistakes\n\nNever inline SVG.\n',
    );

    await apply(
      {
        entries: [],
        placements: [
          { path: 'ANTI_PATTERNS/drupal-mistakes.md', category: 'anti_pattern', tech: 'drupal' },
        ],
      },
      { selectedTopics: [], rerouteGlobal: ['ANTI_PATTERNS/drupal-mistakes.md'] },
    );

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote.mock.calls[0]![1].title).toBe('Drupal mistakes');
    expect(h.promote.mock.calls[0]![1].description).toBeUndefined();
  });
});

// The backstop that keeps an entry local when it leans on this repository's own code used to read the
// sections only, so a description naming one of its symbols reached every other project unchecked.
describe('08 and a description that names this repository', () => {
  beforeEach(async () => {
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(
      path.join(repo, 'src', 'Cart.php'),
      '<?php\nfunction acme_cart_total($cart) { return 0; }\n',
    );
  });

  it('keeps the entry local when its description calls a symbol this repository defines', async () => {
    const out = await apply({
      entries: [entry({ description: 'Never call acme_cart_total() before the cart is built.' })],
    });

    expect(h.promote).not.toHaveBeenCalled();
    expect(out.globalPromoted).toBe(0);
  });

  it('promotes the same entry once the description no longer does', async () => {
    await apply({
      entries: [entry({ description: 'Never total a cart before it is built.' })],
    });

    expect(h.promote).toHaveBeenCalledTimes(1);
  });
});
