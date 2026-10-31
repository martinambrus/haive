import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_PROVIDER_CATALOG } from '@haive/shared';
import type { AgentMiningResult, StepContext } from '../src/step-engine/step-definition.js';
import { skillGenerationStep } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { skillRepairStep } from '../src/step-engine/steps/onboarding/09_5b-skill-repair.js';
import { listSkillDirs } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';
import {
  withoutGitDataDirs,
  withoutUnsafeSkillIds,
} from '../src/step-engine/steps/onboarding/_helpers.js';
import { skillSyncStep } from '../src/step-engine/steps/workflow/11d-skill-sync.js';

/**
 * `detected.skillTargetDirs` is read back from the STORED detect payload, so a legacy or
 * hand-edited one may name any string. The three steps that write (and, for two of them, remove)
 * under it must leave out a dir that names git data, and say so.
 */

const execFileP = promisify(execFile);

const REFUSED = ['.git/hooks', '.GIT./hooks', 'git~1/hooks'];
const ORDINARY = '.claude/skills';
const STORED = [...REFUSED, ORDINARY];
const HOOK = '#!/bin/sh\nexit 0\n';
const KEEP = 'keep me\n';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'skill-target-git-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function recordingLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
}
type RecordingLogger = ReturnType<typeof recordingLogger>;

const asLogger = (log: RecordingLogger) => log as unknown as StepContext['logger'];
const warnedDirs = (log: RecordingLogger): string[] =>
  log.warn.mock.calls.map(([fields]) => (fields as { dir: string }).dir);

const ctxFor = (log: RecordingLogger, over: Record<string, unknown> = {}): StepContext =>
  ({ repoPath: repo, logger: log, ...over }) as unknown as StepContext;

async function put(rel: string, text: string): Promise<void> {
  const file = path.join(repo, ...rel.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(path.join(repo, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}

/** Every file under `rel` with its bytes, so an overwrite shows as well as an add or a delete. */
async function snapshot(rel: string): Promise<string[]> {
  const root = path.join(repo, ...rel.split('/'));
  const out: string[] = [];
  const walk = async (sub: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, sub), { withFileTypes: true })) {
      const next = sub === '' ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else out.push(`${next}:${await readFile(path.join(root, next), 'utf8')}`);
    }
  };
  await walk('');
  return out.sort();
}

/** The step's result or its failure, so the disk can be inspected whichever happened. */
async function settle<T>(run: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  try {
    return { value: await run };
  } catch (error) {
    return { error };
  }
}

function skill(id: string) {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    overview: 'What this domain covers.',
    subSkills: [
      {
        slug: 'alpha',
        name: `${id}-alpha`,
        title: 'Alpha',
        description: 'd',
        summary: 's',
        body: '## Purpose\n\nx',
      },
    ],
  };
}

const mined = (id: string): AgentMiningResult => ({
  agentId: id,
  agentTitle: id,
  status: 'done',
  output: { skills: [skill(id)] },
  rawOutput: null,
  errorMessage: null,
});

describe('09_5 skillGenerationStep.apply with a stored git-data target dir', () => {
  const applyWith = (dirs: string[], log: RecordingLogger) =>
    skillGenerationStep.apply(ctxFor(log), {
      detected: {
        framework: 'general',
        language: 'php',
        kbFiles: [],
        requiredDomains: [],
        skillTargetDirs: dirs,
        bundleSkills: [],
      },
      formValues: {},
      iteration: 0,
      previousIterations: [],
      isFinalLlmAttempt: true,
      llmOutput: { skills: [skill('conventions')] },
    } as unknown as Parameters<typeof skillGenerationStep.apply>[1]);

  it('writes only the ordinary dir, records only it, and names each dir it left out', async () => {
    await put('.git/hooks/pre-commit', HOOK);
    const before = await snapshot('.git');
    const log = recordingLogger();

    const out = await applyWith(STORED, log);

    expect(await readdir(path.join(repo, '.git', 'hooks'))).toEqual(['pre-commit']);
    expect(await snapshot('.git')).toEqual(before);
    expect(await exists('.GIT.')).toBe(false);
    expect(await exists('git~1')).toBe(false);

    expect(await exists(`${ORDINARY}/conventions/SKILL.md`)).toBe(true);
    expect(await exists(`${ORDINARY}/conventions/sub-skills/alpha.md`)).toBe(true);
    expect(await exists(`${ORDINARY}/README.md`)).toBe(true);
    expect(out.written[0]!.mirroredDirs).toEqual([ORDINARY]);
    expect(Object.keys(out.skillReadmeHashes ?? {})).toEqual([ORDINARY]);
    expect(warnedDirs(log)).toEqual(REFUSED);
  });

  it('writes nothing and ends the loop when every stored dir names git data', async () => {
    await put('.git/hooks/pre-commit', HOOK);
    const before = await snapshot('.git');
    const log = recordingLogger();

    const out = await applyWith(['.git/hooks'], log);

    expect(out.written).toEqual([]);
    expect(await readdir(repo)).toEqual(['.git']);
    expect(await snapshot('.git')).toEqual(before);
    expect(warnedDirs(log)).toEqual(['.git/hooks']);
    expect(
      await skillGenerationStep.loop!.shouldContinue({
        ctx: ctxFor(log),
        applyOutput: out,
        llmOutput: null,
        iteration: 0,
        previousIterations: [],
      }),
    ).toBe(false);
  });
});

describe('09_5b skillRepairStep.apply with a stored git-data target dir', () => {
  it('clears and rewrites only the ordinary dir, and names each dir it left out', async () => {
    await put('.git/hooks/pre-commit', HOOK);
    // The recursive-remove target: a skill dir of the failing skill's own id inside git data.
    await put('.git/hooks/conventions/keep.txt', KEEP);
    await put(`${ORDINARY}/conventions/SKILL.md`, '# Conventions\n\n(no overview)\n');
    await put(`${ORDINARY}/conventions/sub-skills/stale.md`, 'not a real sub-skill');
    const before = await snapshot('.git');
    const log = recordingLogger();

    const out = await skillRepairStep.apply(ctxFor(log), {
      detected: {
        failingSkills: [
          {
            skillId: 'conventions',
            issues: ['no sub-skills'],
            skillMdExcerpt: null,
            maxSub: 8,
            bodyLen: '100-250',
            shrunk: false,
          },
        ],
        skillTargetDirs: STORED,
        framework: null,
        language: null,
        kbFiles: [],
      },
      formValues: {},
      agentMiningResults: [mined('conventions')],
      iteration: 0,
      previousIterations: [],
    } as unknown as Parameters<typeof skillRepairStep.apply>[1]);

    expect(await readFile(path.join(repo, '.git/hooks/conventions/keep.txt'), 'utf8')).toBe(KEEP);
    expect(await snapshot('.git')).toEqual(before);
    expect(await exists('.GIT.')).toBe(false);
    expect(await exists('git~1')).toBe(false);

    expect(await exists(`${ORDINARY}/conventions/sub-skills/stale.md`)).toBe(false);
    expect(await readFile(path.join(repo, ORDINARY, 'conventions', 'SKILL.md'), 'utf8')).toContain(
      'conventions title',
    );
    expect(await exists(`${ORDINARY}/conventions/sub-skills/alpha.md`)).toBe(true);
    expect(out.repaired).toEqual(['conventions']);
    expect(Object.keys(out.repairedReadmeHashes ?? {})).toEqual([ORDINARY]);
    expect(warnedDirs(log)).toEqual(REFUSED);
  });
});

describe('11d skillSyncStep.apply with a stored git-data target dir', () => {
  it('writes, removes and stages only under the ordinary dir, and names each dir it left out', async () => {
    // A real repository: 11d refuses a `.git` entry git cannot use, and a bare `hooks/` is one.
    await execFileP('git', ['-C', repo, 'init', '-q']);
    await put('.git/hooks/pre-commit', HOOK);
    await put('.git/hooks/old/keep.txt', KEEP);
    await put('.git/hooks/conventions/keep.txt', KEEP);
    await put(`${ORDINARY}/old/SKILL.md`, '# Old\n');
    const before = await snapshot('.git/hooks');
    const log = recordingLogger();

    const settled = await settle(
      skillSyncStep.apply(
        ctxFor(log, {
          userId: 'u',
          db: { query: { users: { findFirst: async () => null } } },
        }),
        {
          detected: {
            targets: [
              {
                kind: 'new',
                skillId: 'conventions',
                capability: 'Conventions',
                rationale: 'what it does',
                skillMdExcerpt: null,
              },
            ],
            removals: ['old'],
            skillTargetDirs: STORED,
            worktreePath: repo,
            framework: 'general',
            language: 'php',
            kbFiles: [],
            __fileTree: '(tree)',
            __scopeExclude: [],
          },
          formValues: {},
          agentMiningResults: [mined('conventions')],
          iteration: 0,
          previousIterations: [],
        } as unknown as Parameters<typeof skillSyncStep.apply>[1],
      ),
    );

    // The disk comes first: a step that threw part-way has already written and removed.
    for (const keep of ['old', 'conventions']) {
      expect(await readFile(path.join(repo, '.git/hooks', keep, 'keep.txt'), 'utf8')).toBe(KEEP);
    }
    expect(await snapshot('.git/hooks')).toEqual(before);
    expect(await exists('.GIT.')).toBe(false);
    expect(await exists('git~1')).toBe(false);

    expect(await exists(`${ORDINARY}/conventions/SKILL.md`)).toBe(true);
    expect(await exists(`${ORDINARY}/conventions/sub-skills/alpha.md`)).toBe(true);
    expect(await exists(`${ORDINARY}/README.md`)).toBe(true);
    expect(await exists(`${ORDINARY}/old`)).toBe(false);
    expect(warnedDirs(log)).toEqual(REFUSED);

    if ('error' in settled) throw settled.error;
    const out = settled.value;
    expect(out.generated).toEqual(['conventions']);
    expect(out.removed).toEqual(['old']);
    // What was staged and committed: the ordinary dir's files and nothing else.
    expect(out.committed).toBe(true);
    const { stdout } = await execFileP('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'HEAD']);
    expect(stdout.trim().split('\n').sort()).toEqual([
      `${ORDINARY}/README.md`,
      `${ORDINARY}/conventions/SKILL.md`,
      `${ORDINARY}/conventions/sub-skills/alpha.md`,
    ]);
  });
});

describe('withoutGitDataDirs', () => {
  it('keeps every skills dir a provider can declare, and logs nothing', () => {
    const log = recordingLogger();
    const dirs = Object.values(CLI_PROVIDER_CATALOG).map((p) => p.projectSkillsDir);

    expect(dirs.length).toBeGreaterThan(0);
    expect(withoutGitDataDirs(dirs, asLogger(log))).toEqual(dirs);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops exactly the git-data dirs from a mixed list, in order, naming each', () => {
    const log = recordingLogger();
    const mixed = [
      '.claude/skills',
      '.git/hooks',
      '.gemini/skills',
      '.GIT./hooks',
      '.agents/skills',
      'sub/.git',
      'git~1/hooks',
      '.grok/skills',
      '.github/x',
    ];

    expect(withoutGitDataDirs(mixed, asLogger(log))).toEqual([
      '.claude/skills',
      '.gemini/skills',
      '.agents/skills',
      '.grok/skills',
    ]);
    expect(warnedDirs(log)).toEqual([
      '.git/hooks',
      '.GIT./hooks',
      'sub/.git',
      'git~1/hooks',
      '.github/x',
    ]);
  });
});

/**
 * A skill ID is a directory name read from disk (09_5b, 11d) or from a stored payload, so it may
 * name git data too: a skills repository cloned into a skills dir lists as a `.git` skill.
 */
const GIT_IDS = ['.git', '.GIT.', 'git~1'];

const warnedSkillIds = (log: RecordingLogger): string[] =>
  log.warn.mock.calls.flatMap(([fields]) => {
    const skillId = (fields as { skillId?: string } | undefined)?.skillId;
    return skillId === undefined ? [] : [skillId];
  });

const failing = (skillId: string) => ({
  skillId,
  issues: ['no sub-skills'],
  skillMdExcerpt: null,
  maxSub: 8,
  bodyLen: '100-250',
  shrunk: false,
});

describe('listSkillDirs with an entry that names git data', () => {
  it('lists the ordinary skill dirs and no git-data dir', async () => {
    for (const name of ['alpha', '.github', ...GIT_IDS]) {
      await put(`${ORDINARY}/${name}/keep.txt`, KEEP);
    }

    expect(await listSkillDirs(repo, ORDINARY)).toEqual(['.github', 'alpha']);
  });
});

describe('09_5b skillRepairStep.apply with a failing skill id that names git data', () => {
  it('repairs only the ordinary skill, leaves each git-data dir as it was, and names each id', async () => {
    for (const id of GIT_IDS) await put(`${ORDINARY}/${id}/keep.txt`, KEEP);
    await put(`${ORDINARY}/conventions/SKILL.md`, '# Conventions\n\n(no overview)\n');
    await put(`${ORDINARY}/conventions/sub-skills/stale.md`, 'not a real sub-skill');
    const ids = ['conventions', ...GIT_IDS];
    const log = recordingLogger();

    const out = await skillRepairStep.apply(ctxFor(log), {
      detected: {
        failingSkills: ids.map(failing),
        skillTargetDirs: [ORDINARY],
        framework: null,
        language: null,
        kbFiles: [],
      },
      formValues: {},
      agentMiningResults: ids.map(mined),
      iteration: 0,
      previousIterations: [],
    } as unknown as Parameters<typeof skillRepairStep.apply>[1]);

    for (const id of GIT_IDS) {
      expect(await readFile(path.join(repo, ORDINARY, id, 'keep.txt'), 'utf8')).toBe(KEEP);
      expect(await readdir(path.join(repo, ORDINARY, id))).toEqual(['keep.txt']);
    }

    expect(await exists(`${ORDINARY}/conventions/sub-skills/stale.md`)).toBe(false);
    expect(await readFile(path.join(repo, ORDINARY, 'conventions', 'SKILL.md'), 'utf8')).toContain(
      'conventions title',
    );
    expect(await exists(`${ORDINARY}/conventions/sub-skills/alpha.md`)).toBe(true);
    expect(out.repaired).toEqual(['conventions']);
    expect(out.stillFailing).toEqual(GIT_IDS);
    expect(out.degradedNote).toBeDefined();
    expect(warnedSkillIds(log)).toEqual(GIT_IDS);
  });
});

describe('11d skillSyncStep.apply with a skill id that names git data', () => {
  it('generates and removes only ordinary skills, and names each id it refused', async () => {
    await execFileP('git', ['-C', repo, 'init', '-q']);
    await put(`${ORDINARY}/.git/keep.txt`, KEEP);
    await put(`${ORDINARY}/old/SKILL.md`, '# Old\n');
    const log = recordingLogger();

    const settled = await settle(
      skillSyncStep.apply(
        ctxFor(log, {
          userId: 'u',
          db: { query: { users: { findFirst: async () => null } } },
        }),
        {
          detected: {
            targets: ['conventions', '.git'].map((skillId) => ({
              kind: 'new',
              skillId,
              capability: 'Conventions',
              rationale: 'what it does',
              skillMdExcerpt: null,
            })),
            removals: ['old', '.git'],
            skillTargetDirs: [ORDINARY],
            worktreePath: repo,
            framework: 'general',
            language: 'php',
            kbFiles: [],
            __fileTree: '(tree)',
            __scopeExclude: [],
          },
          formValues: {},
          agentMiningResults: [mined('conventions'), mined('.git')],
          iteration: 0,
          previousIterations: [],
        } as unknown as Parameters<typeof skillSyncStep.apply>[1],
      ),
    );

    // The disk comes first: a step that threw part-way has already written and removed.
    expect(await readFile(path.join(repo, ORDINARY, '.git', 'keep.txt'), 'utf8')).toBe(KEEP);
    expect(await readdir(path.join(repo, ORDINARY, '.git'))).toEqual(['keep.txt']);
    expect(await exists(`${ORDINARY}/conventions/SKILL.md`)).toBe(true);
    expect(await exists(`${ORDINARY}/old`)).toBe(false);
    // One refusal even when the ID appears as both a target and a removal.
    expect(warnedSkillIds(log)).toEqual(['.git']);

    if ('error' in settled) throw settled.error;
    const out = settled.value;
    expect(out.generated).toEqual(['conventions']);
    expect(out.removed).toEqual(['old']);
    expect(out.skipped).toEqual(['.git']);
    expect(out.degradedNote).toBeDefined();
  });
});

describe('09_5b and 11d apply when every stored skills dir names git data', () => {
  it('09_5b repairs nothing and creates nothing', async () => {
    await put('.git/hooks/pre-commit', HOOK);
    await put('.git/hooks/conventions/keep.txt', KEEP);
    const before = await snapshot('.git');
    const log = recordingLogger();

    const out = await skillRepairStep.apply(ctxFor(log), {
      detected: {
        failingSkills: [failing('conventions')],
        skillTargetDirs: ['.git/hooks'],
        framework: null,
        language: null,
        kbFiles: [],
      },
      formValues: {},
      agentMiningResults: [mined('conventions')],
      iteration: 0,
      previousIterations: [],
    } as unknown as Parameters<typeof skillRepairStep.apply>[1]);

    expect(out.repaired).toEqual([]);
    expect(out.attempted).toBe(0);
    expect(await readdir(repo)).toEqual(['.git']);
    expect(await snapshot('.git')).toEqual(before);
    expect(warnedDirs(log)).toEqual(['.git/hooks']);
  });

  it('11d generates, removes and commits nothing, and creates nothing', async () => {
    await put('.git/hooks/pre-commit', HOOK);
    await put('.git/hooks/old/keep.txt', KEEP);
    await put('.git/hooks/conventions/keep.txt', KEEP);
    const before = await snapshot('.git');
    const log = recordingLogger();

    const out = await skillSyncStep.apply(ctxFor(log), {
      detected: {
        targets: [
          {
            kind: 'new',
            skillId: 'conventions',
            capability: 'Conventions',
            rationale: 'what it does',
            skillMdExcerpt: null,
          },
        ],
        removals: ['old'],
        skillTargetDirs: ['.git/hooks'],
        worktreePath: repo,
        framework: 'general',
        language: 'php',
        kbFiles: [],
        __fileTree: '(tree)',
        __scopeExclude: [],
      },
      formValues: {},
      agentMiningResults: [mined('conventions')],
      iteration: 0,
      previousIterations: [],
    } as unknown as Parameters<typeof skillSyncStep.apply>[1]);

    expect(out.generated).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.committed).toBe(false);
    expect(await readdir(repo)).toEqual(['.git']);
    expect(await snapshot('.git')).toEqual(before);
    expect(warnedDirs(log)).toEqual(['.git/hooks']);
  });
});

const genDetect = (dirs: string[]) => ({
  framework: null,
  language: null,
  kbFiles: [],
  requiredDomains: [],
  skillTargetDirs: dirs,
  bundleSkills: [],
});
const repairDetect = (dirs: string[], ids = ['conventions']) => ({
  ...genDetect(dirs),
  failingSkills: ids.map(failing),
});
const syncDetect = (dirs: string[], ids = ['conventions'], removals: string[] = []) => ({
  ...genDetect(dirs),
  worktreePath: repo,
  removals,
  targets: ids.map((skillId) => ({
    kind: 'new',
    skillId,
    capability: 'Conventions',
    rationale: '',
    skillMdExcerpt: null,
  })),
});
const applyArgs = (detected: unknown) => ({
  detected,
  formValues: {},
  iteration: 0,
  previousIterations: [],
  isFinalLlmAttempt: true,
  llmOutput: { skills: [skill('conventions')] },
  agentMiningResults: [mined('conventions')],
});

describe('stored skill dispatch targets', () => {
  beforeEach(() => vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0'));
  afterEach(() => vi.unstubAllEnvs());
  it('09_5 skips both sequential and parallel dispatch for git-data-only dirs', async () => {
    const detected = { ...genDetect(REFUSED), requiredDomains: ['Billing', 'Search', 'Orders'] };
    expect
      .soft(skillGenerationStep.llm!.skipIf!({ detected, formValues: {}, iteration: 1 } as never))
      .toBe(true);
    expect(
      await skillGenerationStep.agentMining!.selectAgents({ detected, formValues: {} } as never),
    ).toEqual([]);
  });
  it.each([
    { step: skillRepairStep, detected: () => repairDetect(REFUSED) },
    { step: skillSyncStep, detected: () => syncDetect(REFUSED) },
  ])('does not dispatch for git-data-only dirs: $step.metadata.id', async ({ step, detected }) => {
    expect(
      await step.agentMining!.selectAgents({ detected: detected(), formValues: {} } as never),
    ).toEqual([]);
  });
  it.each([
    { step: skillRepairStep, detected: () => repairDetect(STORED, ['conventions', ...GIT_IDS]) },
    { step: skillSyncStep, detected: () => syncDetect(STORED, ['conventions', ...GIT_IDS]) },
  ])(
    'filters ids and chooses the valid primary in $step.metadata.id prompts',
    async ({ step, detected }) => {
      const agents = await step.agentMining!.selectAgents({
        detected: detected(),
        formValues: {},
      } as never);
      expect(agents.map((a) => a.agentId)).toEqual(['conventions']);
      expect(agents[0]?.prompt).toContain(ORDINARY);
      for (const dir of REFUSED) expect(agents[0]?.prompt).not.toContain(dir);
    },
  );
  it('09_5 omits refused dirs and bundle ids from sequential and loop prompts', () => {
    const detected = { ...genDetect(STORED), bundleSkills: [skill('.git')] };
    const prompt = skillGenerationStep.llm!.buildPrompt({ detected, formValues: {} } as never);
    expect(prompt).toContain(ORDINARY);
    for (const dir of REFUSED) expect(prompt).not.toContain(dir);
    expect(prompt).not.toContain('.git');
  });
});
describe('09_5 stored loop IDs', () => {
  const refusedIds = ['.git', 'nested/unsafe-loop-id'];

  it('omits refused bundle IDs from the first loop prompt', () => {
    const prompt = skillGenerationStep.loop!.buildIterationPrompt!({
      detected: { ...genDetect([ORDINARY]), bundleSkills: refusedIds.map(skill) },
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    for (const id of refusedIds) expect(prompt).not.toContain(id);
  });

  it('filters prior written IDs from the next loop prompt, output and README', async () => {
    const log = recordingLogger();
    const detected = genDetect([ORDINARY]);
    const first = await skillGenerationStep.apply(ctxFor(log), applyArgs(detected) as never);
    const prior = {
      ...first,
      written: [
        ...first.written,
        ...refusedIds.map((id) => ({ ...first.written[0]!, id, title: id, description: id })),
      ],
    };
    const previousIterations = [{ applyOutput: prior }];
    const prompt = skillGenerationStep.loop!.buildIterationPrompt!({
      detected,
      formValues: {},
      iteration: 1,
      previousIterations,
    } as never);
    expect(prompt).toContain('conventions');
    for (const id of refusedIds) expect(prompt).not.toContain(id);
    const out = await skillGenerationStep.apply(ctxFor(log), {
      ...applyArgs(detected),
      iteration: 1,
      llmOutput: null,
      previousIterations,
    } as never);
    expect(out.written.map((w) => w.id)).toEqual(['conventions']);
    const readme = await readFile(path.join(repo, ORDINARY, 'README.md'), 'utf8');
    for (const id of refusedIds) expect(readme).not.toContain(id);
  });
});

describe('empty stored destinations with refused IDs', () => {
  it('repair does not claim failing skills when no destinations were stored', async () => {
    const out = await skillRepairStep.apply(
      ctxFor(recordingLogger()),
      applyArgs(repairDetect([], ['conventions', '.git'])) as never,
    );
    expect(out.stillFailing).toEqual([]);
    expect(out.attempted).toBe(0);
  });

  it('sync does not claim skipped targets when no destinations were stored', async () => {
    const out = await skillSyncStep.apply(
      ctxFor(recordingLogger()),
      applyArgs(syncDetect([], ['conventions', '.git'])) as never,
    );
    expect(out.skipped).toEqual([]);
    expect(out.committed).toBe(false);
  });
});

describe('all-refused destination summaries', () => {
  it.each([
    { step: skillGenerationStep, detected: () => genDetect(REFUSED) },
    { step: skillRepairStep, detected: () => repairDetect(REFUSED) },
  ])('explains refused stored destinations: $step.metadata.id', async ({ step, detected }) => {
    const out = await step.apply(ctxFor(recordingLogger()), applyArgs(detected()) as never);
    expect(out.summary).toBe('Every stored skill destination was refused; no skills were applied.');
  });

  it.each([
    { step: skillGenerationStep, detected: () => genDetect([]) },
    { step: skillRepairStep, detected: () => repairDetect([]) },
  ])('retains the explicit empty-list summary: $step.metadata.id', async ({ step, detected }) => {
    const out = await step.apply(ctxFor(recordingLogger()), applyArgs(detected()) as never);
    expect(out.summary).toBe('The repository maintains no skill destinations.');
  });
});
describe('stored skill positive path validation', () => {
  beforeEach(() => vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0'));
  afterEach(() => vi.unstubAllEnvs());
  it('accepts only a single non-git-data ID segment', () => {
    expect(
      withoutUnsafeSkillIds([
        'alpha',
        '.github',
        '',
        '.',
        '..',
        'a/b',
        String.raw`a\b`,
        '\0',
        ...GIT_IDS,
      ]),
    ).toEqual(['alpha', '.github']);
  });
  it.each(['', '.', 'other/skills'])(
    'does not dispatch to a noncatalog directory %j',
    async (dir) => {
      const generation = { ...genDetect([dir]), requiredDomains: ['Billing', 'Search', 'Orders'] };
      expect(
        skillGenerationStep.llm!.skipIf!({
          detected: generation,
          formValues: {},
          iteration: 1,
        } as never),
      ).toBe(true);
      for (const [step, detected] of [
        [skillGenerationStep, generation],
        [skillRepairStep, repairDetect([dir])],
        [skillSyncStep, syncDetect([dir])],
      ] as const) {
        expect(await step.agentMining!.selectAgents({ detected, formValues: {} } as never)).toEqual(
          [],
        );
      }
    },
  );
  it.each(['a/b', String.raw`a\b`, '', '.', '..'])('does not dispatch a path ID %j', async (id) => {
    for (const [step, detected] of [
      [skillRepairStep, repairDetect([ORDINARY], [id])],
      [skillSyncStep, syncDetect([ORDINARY], [id])],
    ] as const) {
      expect(await step.agentMining!.selectAgents({ detected, formValues: {} } as never)).toEqual(
        [],
      );
    }
  });
  it.each(['', '.', 'other/skills', '.claude/skills/../skills'])(
    'refuses noncatalog directory %j',
    async (dir) => {
      for (const [step, detected] of [
        [skillGenerationStep, genDetect([dir])],
        [skillRepairStep, repairDetect([dir])],
        [skillSyncStep, syncDetect([dir], ['conventions'], ['old'])],
      ] as const) {
        const log = recordingLogger();
        await step.apply(ctxFor(log), applyArgs(detected) as never);
        expect(await readdir(repo)).toEqual([]);
        expect(log.warn).toHaveBeenCalled();
      }
    },
  );
  it('refuses multi-segment bundle IDs before generation writes', async () => {
    const log = recordingLogger();
    const out = await skillGenerationStep.apply(
      ctxFor(log),
      applyArgs({ ...genDetect([ORDINARY]), bundleSkills: [skill('a/b'), skill('.git')] }) as never,
    );
    expect(out.written.map((w) => w.id)).toEqual(['conventions']);
    expect(await exists(`${ORDINARY}/a`)).toBe(false);
    expect(await exists(`${ORDINARY}/.git`)).toBe(false);
    expect(warnedSkillIds(log)).toEqual(['a/b', '.git']);
  });
  it('repair preserves a multi-segment ID tree', async () => {
    await put(`${ORDINARY}/a/b/keep.txt`, KEEP);
    const log = recordingLogger();
    const out = await skillRepairStep.apply(
      ctxFor(log),
      applyArgs(repairDetect([ORDINARY], ['a/b'])) as never,
    );
    expect(await readFile(path.join(repo, ORDINARY, 'a/b/keep.txt'), 'utf8')).toBe(KEEP);
    expect(out.repaired).toEqual([]);
    expect(warnedSkillIds(log)).toEqual(['a/b']);
  });
  it('sync preserves a multi-segment ID for writes and removals', async () => {
    await put(`${ORDINARY}/a/b/keep.txt`, KEEP);
    const log = recordingLogger();
    const out = await skillSyncStep.apply(
      ctxFor(log),
      applyArgs(syncDetect([ORDINARY], ['a/b'], ['a/b'])) as never,
    );
    expect(await readFile(path.join(repo, ORDINARY, 'a/b/keep.txt'), 'utf8')).toBe(KEEP);
    expect(out.generated).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.committed).toBe(false);
  });
});
describe('stored target refusals are visible once per run', () => {
  it.each([
    { step: skillGenerationStep, detected: () => genDetect(REFUSED) },
    { step: skillRepairStep, detected: () => repairDetect(REFUSED) },
    { step: skillSyncStep, detected: () => syncDetect(REFUSED, ['conventions'], ['old']) },
  ])(
    'sets degradedNote even when every dir is dropped: $step.metadata.id',
    async ({ step, detected }) => {
      const log = recordingLogger();
      const out = await step.apply(ctxFor(log), applyArgs(detected()) as never);
      expect(out.degradedNote).toBeTruthy();
    },
  );
  it('09_5 logs dropped dirs once across loop passes and retains the note', async () => {
    const log = recordingLogger();
    const detected = genDetect(STORED);
    const first = await skillGenerationStep.apply(ctxFor(log), applyArgs(detected) as never);
    const out = await skillGenerationStep.apply(ctxFor(log), {
      ...applyArgs(detected),
      iteration: 1,
      llmOutput: null,
      previousIterations: [{ applyOutput: first }],
    } as never);
    expect(warnedDirs(log)).toEqual(REFUSED);
    expect(first.degradedNote).toBeTruthy();
    expect(out.degradedNote).toBe(first.degradedNote);
  });
  it('11d reports a refused removal even with no generation targets', async () => {
    const log = recordingLogger();
    const out = await skillSyncStep.apply(
      ctxFor(log),
      applyArgs(syncDetect([ORDINARY], [], ['.git'])) as never,
    );
    expect(out.degradedNote).toBeTruthy();
    expect(out.removed).toEqual([]);
  });
});
