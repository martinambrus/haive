import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ promote: vi.fn(), clear: vi.fn() }));

vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-promote.js')>();
  return {
    ...actual,
    clearTaskPromotedDrafts: h.clear,
    promoteToGlobalKbDraft: h.promote,
    findConsumedTaskPromotions: async () => new Set<string>(),
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

const rel = 'ANTI_PATTERNS/a.md';
const removed = `.haive-data/knowledge_base/${rel}`;
const body = `# ${rel}\n\nUse public Drupal APIs.\n`;

// A journal nobody can use: each is deterministic content, never an IO fault.
const planted: Record<string, string> = {
  'malformed JSON': '{private sentinel',
  'schema mismatch': '{"private sentinel":true}',
  'invalid path': JSON.stringify({
    version: 1,
    files: [{ path: '../private sentinel.md', body: '# Saved original' }],
  }),
};

let repo: string;
let taskId: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-unusable-'));
  taskId = randomUUID();
  h.promote.mockReset();
  h.promote.mockResolvedValue({ id: randomUUID(), deduped: false });
  h.clear.mockReset();
  h.clear.mockResolvedValue(0);
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
    taskId,
    taskStepId: 'ts1',
    userId: 'u1',
    repoPath: repo,
    workspacePath: repo,
    cliProviderId: null,
    db: { select: () => chain } as unknown as Database,
    logger: logger.child({ test: 'kb-reroute-unusable' }),
    emitProgress: async () => {},
    sandboxWorkdir: '/haive/workdir',
    round: 0,
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
  };
}

async function run(context: StepContext, paths: string[] = [rel]) {
  const out = await knowledgeAcquisitionStep.apply(context, {
    iteration: 0,
    previousIterations: [],
    detected,
    formValues: { selectedTopics: [], rerouteGlobal: paths },
    llmOutput: {
      placements: paths.map((p) => ({ path: p, category: 'anti_pattern', tech: 'drupal' })),
    },
  });
  return out as { removedPaths?: string[] };
}

const kbFile = () => path.join(repo, '.haive-data/knowledge_base', rel);
const recoveryDir = () => path.join(repo, '.haive/kb-reroute-recovery');
const journalFile = () =>
  path.join(recoveryDir(), `${createHash('sha256').update(taskId).digest('hex')}.json`);
const asideFile = () => `${journalFile()}.unusable`;
const present = (file: string) =>
  readFile(file, 'utf8').then(
    () => true,
    () => false,
  );

async function plant(shape: string) {
  await mkdir(path.dirname(kbFile()), { recursive: true });
  await writeFile(kbFile(), body);
  await mkdir(recoveryDir(), { recursive: true });
  await writeFile(journalFile(), planted[shape]!);
}

const namesFile = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.some(([fields]) => (fields as { path?: string } | undefined)?.path === rel);

// T789 item 9
it.each(Object.keys(planted))(
  'sets a %s journal aside, keeps its bytes and lets the re-route proceed',
  async (shape) => {
    await plant(shape);
    const context = ctx();
    const warn = vi.spyOn(context.logger, 'warn');
    const out = await run(context);
    expect(await present(kbFile()), 'kept local although promoted and journalled').toBe(false);
    expect(out.removedPaths).toEqual([removed]);
    expect(await readFile(asideFile(), 'utf8')).toBe(planted[shape]);
    const fresh = JSON.parse(await readFile(journalFile(), 'utf8')) as { files: unknown[] };
    expect(fresh.files).toMatchObject([{ path: rel, body }]);
    // The aside may hold the only original bodies, so no draft is purged while it exists.
    expect(h.clear).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private sentinel');
  },
);

it('re-enables the draft purge once a person removes the aside', async () => {
  await plant('malformed JSON');
  await run(ctx(), []);
  await run(ctx(), []);
  expect(h.clear).not.toHaveBeenCalled();
  await rm(asideFile(), { force: true });
  await run(ctx(), []);
  expect(h.clear).toHaveBeenCalledTimes(1);
});

it('keeps blocking and names the file it kept local when the aside name is taken', async () => {
  await plant('malformed JSON');
  await writeFile(asideFile(), 'earlier aside');
  const context = ctx();
  const warn = vi.spyOn(context.logger, 'warn');
  await run(context);
  expect(await readFile(kbFile(), 'utf8')).toBe(body);
  expect(await readFile(journalFile(), 'utf8')).toBe(planted['malformed JSON']);
  expect(await readFile(asideFile(), 'utf8')).toBe('earlier aside');
  expect(namesFile(warn), 'no warning names the file kept local').toBe(true);
});

it('does not follow a link planted at the aside name', async () => {
  await plant('schema mismatch');
  const sentinel = path.join(repo, 'sentinel');
  await writeFile(sentinel, 'private sentinel');
  await symlink(sentinel, asideFile());
  const context = ctx();
  const warn = vi.spyOn(context.logger, 'warn');
  await run(context);
  expect(await readFile(sentinel, 'utf8')).toBe('private sentinel');
  expect(await readFile(kbFile(), 'utf8')).toBe(body);
  expect(await readFile(journalFile(), 'utf8')).toBe(planted['schema mismatch']);
  expect(namesFile(warn), 'no warning names the file kept local').toBe(true);
});

// Negative control: passes today and must keep passing. A journal, whatever it holds, is never
// the proof a local file may go; only a confirmed promotion is.
it('never removes a local file whose promotion is not confirmed', async () => {
  await plant('malformed JSON');
  h.promote.mockResolvedValue(null);
  await run(ctx());
  expect(await readFile(kbFile(), 'utf8')).toBe(body);
});
