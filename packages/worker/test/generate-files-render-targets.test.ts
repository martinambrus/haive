import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CLI_PROVIDER_CATALOG, type CliProviderName } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { generateFilesStep } from '../src/step-engine/steps/onboarding/07-generate-files.js';

// Pins what 07's detect derives for a render context's per-install half, through the public step so
// it holds wherever the derivation lives. The literals are today's adapters and catalog.

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK_CLI_USER = '00000000-0000-4000-8000-0000000000a2';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Provider {
  name: CliProviderName;
  enabled: boolean;
}
const on = (...names: CliProviderName[]): Provider[] =>
  names.map((name) => ({ name, enabled: true }));
const off = (...names: CliProviderName[]): Provider[] =>
  names.map((name) => ({ name, enabled: false }));

/** The two derived fields detect returns for `providers`, in this row order; `lspLanguages` is what the
 *  tooling step recorded (`null`: nothing). Every table is registered, so a new read finds it empty. */
async function derive(providers: Provider[], lspLanguages: string[] | null) {
  const repoPath = await mkdtemp(join(tmpdir(), 'generate-files-render-targets-'));
  dirs.push(repoPath);
  const tables = Object.fromEntries(
    Object.entries(schema).filter(([, value]) => is(value, PgTable)),
  ) as Record<string, PgTable>;
  const fake = createFakeDb(tables);
  for (const p of providers) {
    fake.insert(schema.cliProviders, {
      userId: USER,
      name: p.name,
      label: p.name,
      enabled: p.enabled,
      rulesContent: '',
    });
  }
  // The task's own CLI is another user's row, so it is not one of the providers under test.
  const taskCli = fake.insert(schema.cliProviders, {
    userId: TASK_CLI_USER,
    name: 'claude-code',
    label: 'task cli',
    enabled: true,
    rulesContent: '',
  });
  if (lspLanguages !== null) {
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '04-tooling-infrastructure',
      round: 0,
      output: { tooling: { lspLanguages } },
    });
  }
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    taskId: TASK,
    userId: USER,
    cliProviderId: taskCli.id,
    repoPath,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const out = await generateFilesStep.detect!(ctx);
  return { agentTargets: out.agentTargets, enabledCliProviders: out.enabledCliProviders };
}

const LANGUAGES = ['php-extended'];

const ENABLED = {
  'claude-code': { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
  codex: { name: 'codex', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
  gemini: { name: 'gemini', rulesFile: 'GEMINI.md', rulesFileMode: 'import' },
  amp: { name: 'amp', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
  zai: { name: 'zai', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
  antigravity: { name: 'antigravity', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
  ollama: { name: 'ollama', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
  muse: { name: 'muse', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
  grok: { name: 'grok', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
  openrouter: { name: 'openrouter', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
} as const satisfies Record<CliProviderName, object>;
const listed = (...names: CliProviderName[]) => names.map((name) => ENABLED[name]);

const target = (dir: string, format: 'markdown' | 'toml', supportsLsp: boolean) => ({
  dir,
  format,
  supportsLsp,
});
const CLAUDE = (lsp: boolean) => target('.claude/agents', 'markdown', lsp);
const CODEX = (lsp: boolean) => target('.codex/agents', 'toml', lsp);
const GEMINI = (lsp: boolean) => target('.gemini/agents', 'markdown', lsp);
const GROK = (lsp: boolean) => target('.grok/agents', 'markdown', lsp);
const ANTIGRAVITY = (lsp: boolean) => target('.agents/agents', 'markdown', lsp);

describe('07 detect: agent targets and enabled providers', () => {
  it('gives the providers that share an agents directory one target, and lists each of them', async () => {
    const two = await derive(on('claude-code', 'zai'), LANGUAGES);
    expect(two.agentTargets).toEqual([CLAUDE(true)]);
    expect(two.enabledCliProviders).toEqual(listed('claude-code', 'zai'));

    const family = await derive(
      on('claude-code', 'zai', 'ollama', 'muse', 'openrouter'),
      LANGUAGES,
    );
    expect(family.agentTargets).toEqual([CLAUDE(true)]);
    expect(family.enabledCliProviders).toEqual(
      listed('claude-code', 'zai', 'ollama', 'muse', 'openrouter'),
    );
  });

  it('gives a provider with no agents directory no target, and still lists it', async () => {
    const mixed = await derive(on('amp', 'codex'), LANGUAGES);
    expect(mixed.agentTargets).toEqual([CODEX(false)]);
    expect(mixed.enabledCliProviders).toEqual(listed('amp', 'codex'));
  });

  it('falls back to the .claude/agents markdown target when no enabled provider has a directory', async () => {
    const alone = await derive(on('amp'), LANGUAGES);
    expect(alone.agentTargets).toEqual([CLAUDE(false)]);
    expect(alone.enabledCliProviders).toEqual(listed('amp'));
  });

  it('leaves a disabled provider out of both', async () => {
    const some = await derive(
      [...on('claude-code'), ...off('gemini', 'codex', 'zai'), ...on('grok')],
      LANGUAGES,
    );
    expect(some.agentTargets).toEqual([CLAUDE(true), GROK(true)]);
    expect(some.enabledCliProviders).toEqual(listed('claude-code', 'grok'));

    const first = await derive([...off('zai'), ...on('claude-code')], LANGUAGES);
    expect(first.agentTargets).toEqual([CLAUDE(true)]);
    expect(first.enabledCliProviders).toEqual(listed('claude-code'));

    const none = await derive(off('claude-code', 'gemini', 'amp'), LANGUAGES);
    expect(none.agentTargets).toEqual([CLAUDE(false)]);
    expect(none.enabledCliProviders).toEqual([]);
  });

  it('marks a target LSP-capable when the task has languages and the provider supports LSP', async () => {
    const out = await derive(
      on('claude-code', 'codex', 'gemini', 'grok', 'antigravity'),
      LANGUAGES,
    );
    expect(out.agentTargets).toEqual([
      CLAUDE(true),
      CODEX(false),
      GEMINI(false),
      GROK(true),
      ANTIGRAVITY(false),
    ]);
  });

  it('marks no target LSP-capable when the task has no LSP languages', async () => {
    for (const recorded of [[], null]) {
      const out = await derive(on('claude-code', 'zai', 'grok', 'codex'), recorded);
      expect(out.agentTargets).toEqual([CLAUDE(false), GROK(false), CODEX(false)]);
    }
  });

  it('orders the targets by the first provider on each directory, and the list as the rows come', async () => {
    const out = await derive(on('gemini', 'claude-code', 'zai', 'codex'), LANGUAGES);
    expect(out.agentTargets).toEqual([GEMINI(false), CLAUDE(true), CODEX(false)]);
    expect(out.enabledCliProviders).toEqual(listed('gemini', 'claude-code', 'zai', 'codex'));
  });

  it('carries each adapter rules file and mode, native and import', async () => {
    const all: CliProviderName[] = [
      'claude-code',
      'codex',
      'gemini',
      'amp',
      'zai',
      'antigravity',
      'ollama',
      'muse',
      'grok',
      'openrouter',
    ];
    const out = await derive(on(...all), LANGUAGES);
    expect(out.enabledCliProviders).toEqual(listed(...all));
    expect(new Set(out.enabledCliProviders.map((p) => p.rulesFileMode))).toEqual(
      new Set(['native', 'import']),
    );
    expect(out.agentTargets).toEqual([
      CLAUDE(true),
      CODEX(false),
      GEMINI(false),
      ANTIGRAVITY(false),
      GROK(true),
    ]);
  });

  it('lists one entry per enabled row, duplicates included, and one target for their directory', async () => {
    const out = await derive(on('claude-code', 'claude-code'), LANGUAGES);
    expect(out.agentTargets).toEqual([CLAUDE(true)]);
    expect(out.enabledCliProviders).toEqual(listed('claude-code', 'claude-code'));
  });

  // Every provider that shares a directory supports LSP alike today, so the rule that one that does
  // is enough can only be seen by changing the catalog for the length of the case.
  it('marks a shared target LSP-capable when any provider on it supports LSP', async () => {
    const zai = CLI_PROVIDER_CATALOG.zai;
    const before = zai.supportsLsp;
    zai.supportsLsp = false;
    try {
      expect((await derive(on('zai', 'claude-code'), LANGUAGES)).agentTargets).toEqual([
        CLAUDE(true),
      ]);
      expect((await derive(on('claude-code', 'zai'), LANGUAGES)).agentTargets).toEqual([
        CLAUDE(true),
      ]);
      expect((await derive(on('zai'), LANGUAGES)).agentTargets).toEqual([CLAUDE(false)]);
    } finally {
      zai.supportsLsp = before;
    }
  });
});
