import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { realSkipDecision, realStepContext } from './support/real-step-context.js';

vi.mock('../src/lsp/configured-lsp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lsp/configured-lsp.js')>()),
  loadConfiguredLspLanguages: async () => ['typescript'],
}));
vi.mock('../src/step-engine/_parallel-cap.js', () => ({ resolveParallelCap: async () => 2 }));

const { makeModelHealthStep } = await import('../src/step-engine/steps/_model-health.js');
const { installPluginsStep } =
  await import('../src/step-engine/steps/workflow/01b-install-plugins.js');
const { verifyFilesStep } =
  await import('../src/step-engine/steps/onboarding/07_5-verify-files.js');
const { finalReviewStep } = await import('../src/step-engine/steps/onboarding/11-final-review.js');
const { skillVerificationStep } =
  await import('../src/step-engine/steps/onboarding/09_6-skill-verification.js');

const USER = 'dddddddd-0000-4000-8000-0000000000d1';
const CLAUDE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CODEX_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

function provider(id: string, name: string, day: number) {
  return {
    id,
    userId: USER,
    name,
    label: name,
    enabled: true,
    createdAt: new Date(Date.UTC(2026, 0, day)),
  };
}
const claude = provider(CLAUDE_ID, 'claude-code', 1);
const codex = provider(CODEX_ID, 'codex', 2);
const codexOldest = provider(CODEX_ID, 'codex', 1);
const claudeNewer = provider(CLAUDE_ID, 'claude-code', 2);

type Row = ReturnType<typeof provider>;

function dbWith(rows: Row[]): Database {
  const fake = createFakeDb({ cliProviders: schema.cliProviders, tasks: schema.tasks });
  for (const r of rows) fake.insert(schema.cliProviders, r);
  return fake.db as unknown as Database;
}

function none(rows: Row[], extra: { repoPath?: string } = {}) {
  return {
    cliProviderId: null,
    providers: rows,
    db: dbWith(rows),
    userId: USER,
    taskId: 'eeeeeeee-0000-4000-8000-0000000000e1',
    ...extra,
  };
}

beforeEach(() => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
});

describe('model health canary', () => {
  const step = makeModelHealthStep('workflow');

  it('runs for a none task that has an enabled provider', async () => {
    const out = await realSkipDecision(none([claude, codex]), step);
    expect(out.skipped).toBe(false);
  });

  it('is skipped for a none task with no provider', async () => {
    const out = await realSkipDecision(none([]), step);
    expect(out.skipped).toBe(true);
  });
});

describe('01b install plugins', () => {
  it('runs on the default provider for a none task', async () => {
    const rows = [claude, codex];
    const out = await realSkipDecision(none(rows), installPluginsStep);
    expect(out.skipped).toBe(false);
    const detected = await installPluginsStep.detect!(out.ctx);
    expect(detected.skipReason).not.toBe('No CLI provider selected for this task');
    expect(detected.providerName).toBe('claude-code');
    expect(detected.skip).toBe(false);
  });

  it('keeps the skip when the user has no provider', async () => {
    const out = await realSkipDecision(none([]), installPluginsStep);
    expect(out.skipped).toBe(true);
    const detected = await installPluginsStep.detect!(out.ctx);
    expect(detected).toMatchObject({
      providerName: null,
      skip: true,
      skipReason: 'No CLI provider selected for this task',
    });
  });
});

describe('the agents directory of a none task', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'none-task-agents-'));
    for (const n of ['a', 'b']) {
      await mkdir(path.join(repo, '.codex/agents'), { recursive: true });
      await writeFile(path.join(repo, `.codex/agents/${n}.toml`), 'x', 'utf8');
    }
    for (const n of ['a', 'b', 'c']) {
      await mkdir(path.join(repo, '.claude/agents'), { recursive: true });
      await writeFile(path.join(repo, `.claude/agents/${n}.md`), 'x', 'utf8');
    }
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const agentsCheck = async (rows: Row[]) => {
    const ctx = await realStepContext(none(rows, { repoPath: repo }));
    const detected = await verifyFilesStep.detect!(ctx);
    return detected.checks.find((c) => c.id === 'agents_dir')!;
  };
  const reviewAgents = async (rows: Row[]) => {
    const ctx = await realStepContext(none(rows, { repoPath: repo }));
    return (await finalReviewStep.detect!(ctx)).counts.agents;
  };

  it('07_5 looks at .codex/agents when the default is codex', async () => {
    const check = await agentsCheck([codexOldest, claudeNewer]);
    expect(check.label).toBe('.codex/agents has at least 10 TOML files');
    expect(check.detail).toBe('found 2');
  });

  it('07_5 looks at .claude/agents when the default is claude-code', async () => {
    const check = await agentsCheck([claude, codex]);
    expect(check.label).toBe('.claude/agents has at least 10 markdown files');
    expect(check.detail).toBe('found 3');
  });

  it('07_5 looks at .claude/agents when there is no provider', async () => {
    const check = await agentsCheck([]);
    expect(check.label).toBe('.claude/agents has at least 10 markdown files');
    expect(check.detail).toBe('found 3');
  });

  it('11 counts the .codex/agents files when the default is codex', async () => {
    expect(await reviewAgents([codexOldest, claudeNewer])).toBe(2);
  });

  it('11 counts the .claude/agents files when the default is claude-code or none', async () => {
    expect(await reviewAgents([claude, codex])).toBe(3);
    expect(await reviewAgents([])).toBe(3);
  });
});

describe('09_6 skill verification', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'none-task-skills-'));
    await mkdir(path.join(repo, '.claude/skills/bad'), { recursive: true });
    await writeFile(path.join(repo, '.claude/skills/bad/SKILL.md'), '', 'utf8');
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('shows the default provider as the current CLI and preselects it for the fix', async () => {
    const ctx = await realStepContext(none([claude, codex], { repoPath: repo }));
    const detected = await skillVerificationStep.detect!(ctx);
    expect(detected.currentCliId).toBe(CLAUDE_ID);
    const form = skillVerificationStep.form!(ctx, detected)!;
    const field = form.fields.find((f) => f.id === 'repairCli') as { default?: string };
    expect(field.default).toBe(CLAUDE_ID);
  });
});
