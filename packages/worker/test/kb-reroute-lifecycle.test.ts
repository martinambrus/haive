import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { GlobalKbDeadlineError } from '@haive/shared/global-kb';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';

// The store is replaced by its seams: the promotion, the purge (a no-op: it never removes the
// entries a test calls durable, as the real one leaves every row that is not a draft) and the
// probe that names which journalled entries a purge cannot remove.
const h = vi.hoisted(() => ({
  promote: vi.fn(),
  consumed: vi.fn(),
  durable: new Set<string>(),
}));

vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-promote.js')>();
  return {
    ...actual,
    clearTaskPromotedDrafts: async () => 0,
    promoteToGlobalKbDraft: h.promote,
    findConsumedTaskPromotions: h.consumed,
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
const bodyOf = (p: string) => `# ${p}\n\nUse public Drupal APIs.\n`;

let repo: string;
let taskId: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-lifecycle-'));
  taskId = randomUUID();
  h.durable.clear();
  h.promote.mockReset();
  h.consumed.mockReset();
  h.consumed.mockImplementation(async (_db: unknown, _task: string, ids: Iterable<string>) => {
    return new Set([...ids].filter((id) => h.durable.has(id)));
  });
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
    logger: logger.child({ test: 'kb-reroute-lifecycle' }),
    emitProgress: async () => {},
    sandboxWorkdir: '/haive/workdir',
    round: 0,
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
  };
}

async function run(paths: string[] = [rel]) {
  const out = await knowledgeAcquisitionStep.apply(ctx(), {
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

const kbFile = (p = rel) => path.join(repo, '.haive-data/knowledge_base', p);
const seed = async (p = rel) => {
  await mkdir(path.dirname(kbFile(p)), { recursive: true });
  await writeFile(kbFile(p), bodyOf(p));
};
const present = (file: string) =>
  readFile(file, 'utf8').then(
    () => true,
    () => false,
  );
const journalFile = () =>
  path.join(
    repo,
    '.haive/kb-reroute-recovery',
    `${createHash('sha256').update(taskId).digest('hex')}.json`,
  );
const readJournal = () =>
  readFile(journalFile(), 'utf8').then(
    (text) => JSON.parse(text) as { files: { path: string; body: string }[] },
    () => null,
  );

/** Re-route one file, then let a person activate its draft: a Retry's purge cannot remove it now. */
async function rerouteThenActivate() {
  const entryId = randomUUID();
  await seed();
  h.promote.mockResolvedValue({ id: entryId, deduped: false });
  const first = await run();
  expect(await present(kbFile())).toBe(false);
  expect(first.removedPaths).toEqual([removed]);
  h.durable.add(entryId);
  // The topic is covered by the activated entry, so a re-promotion dedupes against it.
  h.promote.mockResolvedValue({ id: entryId, deduped: true });
  return entryId;
}

// T789 item 6
it('a Retry restores nothing a purge cannot remove, and still reports its removal', async () => {
  await rerouteThenActivate();
  const retry = await run();
  expect(await present(kbFile()), 'restored although its global entry is active').toBe(false);
  expect(retry.removedPaths, 'step 12 would never stage the deletion').toEqual([removed]);
});

it('restores only the files whose entries are not durable', async () => {
  const [a, b] = ['ANTI_PATTERNS/a.md', 'ANTI_PATTERNS/b.md'] as const;
  const ids = { [a]: randomUUID(), [b]: randomUUID() };
  await seed(a);
  await seed(b);
  h.promote.mockImplementation(async (_db, p) => ({
    id: p.title.includes('a.md') ? ids[a] : ids[b],
    deduped: false,
  }));
  await run([a, b]);
  h.durable.add(ids[a]);
  h.promote.mockRejectedValue(new GlobalKbDeadlineError(12));
  await expect(run([a, b])).rejects.toThrow();
  expect(await present(kbFile(a)), 'a is durable').toBe(false);
  expect(await readFile(kbFile(b), 'utf8')).toBe(bodyOf(b));
  expect((await readJournal())?.files.map((f) => f.path)).toEqual([b]);
});

it('a probe that times out fails the step before anything is restored', async () => {
  await rerouteThenActivate();
  h.consumed.mockRejectedValueOnce(new GlobalKbDeadlineError(12));
  await expect(run()).rejects.toThrow(GlobalKbDeadlineError);
  expect(await present(kbFile())).toBe(false);
  expect((await readJournal())?.files).toHaveLength(1);
});

it('sends only uuid-shaped entry ids to the lookup, and restores an entry whose id is not one', async () => {
  const [a, b] = ['ANTI_PATTERNS/a.md', 'ANTI_PATTERNS/b.md'] as const;
  const ids = { [a]: randomUUID(), [b]: randomUUID() };
  await seed(a);
  await seed(b);
  h.promote.mockImplementation(async (_db, p) => ({
    id: p.title.includes('a.md') ? ids[a] : ids[b],
    deduped: false,
  }));
  await run([a, b]);
  // A sandboxed agent can write the journal: one planted id must not poison the lookup for the rest.
  const saved = JSON.parse(await readFile(journalFile(), 'utf8')) as {
    files: { path: string; entryId?: string }[];
  };
  saved.files.find((f) => f.path === b)!.entryId = 'not-a-uuid';
  await writeFile(journalFile(), JSON.stringify(saved));
  h.durable.add(ids[a]);
  h.promote.mockRejectedValue(new GlobalKbDeadlineError(12));
  await expect(run([a, b])).rejects.toThrow();
  expect(h.consumed.mock.lastCall?.[2]).toEqual([ids[a]]);
  expect(await present(kbFile(a)), 'a is durable').toBe(false);
  expect(await readFile(kbFile(b), 'utf8')).toBe(bodyOf(b));
});

// Negative controls: they pass today and must keep passing, since the journal exists to undo a
// Retry's purge of a draft that is still pending.
it('still restores a file whose draft is pending when the Retry then fails', async () => {
  await seed();
  h.promote.mockResolvedValue({ id: randomUUID(), deduped: false });
  await run();
  expect(await present(kbFile())).toBe(false);
  h.promote.mockRejectedValue(new GlobalKbDeadlineError(12));
  await expect(run()).rejects.toThrow();
  expect(await readFile(kbFile(), 'utf8')).toBe(bodyOf(rel));
});

it('keeps the original body while its draft is still pending', async () => {
  await seed();
  h.promote.mockResolvedValue({ id: randomUUID(), deduped: false });
  await run();
  expect((await readJournal())?.files).toMatchObject([{ path: rel, body: bodyOf(rel) }]);
});

// T789 item 5
it('prunes the entry a Retry found durable, and the journal once it is empty', async () => {
  await rerouteThenActivate();
  await run();
  expect(await readJournal()).toBeNull();
});

it('leaves no entry for a re-route that kept the local copy', async () => {
  await seed();
  h.promote.mockResolvedValue({ id: randomUUID(), deduped: true });
  await run();
  expect(await readFile(kbFile(), 'utf8')).toBe(bodyOf(rel));
  expect(await readJournal()).toBeNull();
});

it('leaves no journal behind when nothing was re-routed', async () => {
  await run([]);
  expect(await readJournal()).toBeNull();
});

it('keeps a body while a different file holds its path, and drops it once the file matches', async () => {
  const { restoreKbReroutes } =
    await import('../src/step-engine/steps/onboarding/_kb-reroute-recovery.js');
  const recovery = await restoreKbReroutes(repo, taskId);
  await recovery.rememberReroute(rel, bodyOf(rel));
  await mkdir(path.dirname(kbFile()), { recursive: true });
  // Later writes of the same apply can put another article at a re-routed path.
  await writeFile(kbFile(), '# A different article\n');
  await recovery.finish();
  expect((await readJournal())?.files).toMatchObject([{ path: rel, body: bodyOf(rel) }]);
  await writeFile(kbFile(), bodyOf(rel));
  await recovery.finish();
  expect(await readJournal()).toBeNull();
});
