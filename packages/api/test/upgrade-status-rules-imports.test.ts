import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import {
  buildClaudeSettingsJson,
  buildCliRulesBlockFromProviders,
  bundleAgentTemplateHash,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  normalizeContent,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  sha256Hex,
} from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { RULES_FILE_READ_CAP } from '@haive/shared/rules-files';

const { state } = vi.hoisted(() => ({
  state: {
    userId: 'user-1',
    repo: null as Record<string, unknown> | null,
    rows: new Map<unknown, unknown[]>(),
    onboarded: false,
  },
}));

// The route reads through `select().from(table)` chains. Each table answers the rows the test put
// there, whatever the WHERE, so every row below is one the route would have selected.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      repositories: { findFirst: async () => state.repo },
      tasks: { findFirst: async () => (state.onboarded ? { id: 'onboarding-1' } : null) },
    },
    select: () => ({
      from: (table: unknown) => {
        const q = {
          where: () => q,
          innerJoin: () => q,
          orderBy: () => q,
          limit: () => q,
          then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
            Promise.resolve(state.rows.get(table) ?? []).then(resolve, reject),
        };
        return q;
      },
    }),
  }),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', state.userId);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({}) }));

import { Hono } from 'hono';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/', upgradeRoutes);
app.onError(errorHandler);

/** A repository whose templates all match the current set, so only its rules files can make an
 *  upgrade available. */
function inSync(providers: { name: string; rulesContent: string; enabled: boolean }[]) {
  const block = buildCliRulesBlockFromProviders(providers);
  const agent = { templateId: 'agent.x', schemaVersion: 1, contentHash: 'h1' };
  const artifact = (templateId: string, templateSchemaVersion: number, hash: string) => ({
    templateId,
    templateSchemaVersion,
    templateContentHash: hash,
    bundleItemId: null,
    haiveVersion: null,
    repositoryId: 'repo-1',
    generatedAt: new Date(1),
  });
  state.rows = new Map<unknown, unknown[]>([
    [schema.templateManifestCache, [{ ...agent, setHash: 's' }]],
    [schema.cliProviders, providers],
    [
      schema.onboardingArtifacts,
      [
        artifact(agent.templateId, agent.schemaVersion, agent.contentHash),
        ...(block
          ? [
              artifact(
                CLI_RULES_TEMPLATE_ID,
                CLI_RULES_SCHEMA_VERSION,
                sha256Hex(normalizeContent(block)),
              ),
            ]
          : []),
      ],
    ],
  ]);
}

const claude = { name: 'claude-code', rulesContent: '', enabled: true };

async function status(): Promise<Record<string, unknown>> {
  const res = await app.request('/repo-1/upgrade-status');
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('upgrade-status and the rules import', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-'));
    outside = await mkdtemp(path.join(tmpdir(), 'upgrade-status-out-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
    };
    inSync([claude]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reports nothing when the enabled providers rules files import AGENTS.md', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
    expect(body.linkedRulesFiles).toBeUndefined();
  });

  it('offers an upgrade for a rules file that lacks the import', async () => {
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(true);
    expect(body.missingRulesImports).toEqual(['CLAUDE.md']);
  });

  it('reports a rules file linked elsewhere without offering an upgrade for it', async () => {
    await writeFile(path.join(outside, 'CLAUDE.md'), '# elsewhere\n', 'utf8');
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(repo, 'CLAUDE.md'));
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
    expect(body.linkedRulesFiles).toEqual(['CLAUDE.md']);
  });

  it('claims nothing about a repository root it cannot read', async () => {
    state.repo = { ...state.repo, storagePath: path.join(repo, 'gone') };
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
  });

  it('asks only the enabled providers for a rules file', async () => {
    inSync([
      { ...claude, enabled: false },
      { name: 'codex', rulesContent: '', enabled: true },
    ]);
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
  });
});

describe('upgrade-status and a template rendered to several paths', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-paths-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
    };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** agent.x rendered to two paths: one row current, one holding a restored edit's own hash. */
  const rows = (order: 'current-first' | 'edited-first') => {
    inSync([claude]);
    const artifacts = state.rows.get(schema.onboardingArtifacts)!;
    const edited = { ...(artifacts[0] as object), templateContentHash: 'h-edited' };
    state.rows.set(
      schema.onboardingArtifacts,
      order === 'current-first' ? [...artifacts, edited] : [edited, ...artifacts],
    );
  };

  it('offers an upgrade while any rendering is not current, whichever row comes first', async () => {
    for (const order of ['current-first', 'edited-first'] as const) {
      rows(order);
      const body = await status();
      expect(body.changedTemplateIds, order).toEqual(['agent.x']);
      expect(body.hasUpgradeAvailable, order).toBe(true);
    }
  });
});

describe('upgrade-status and a repository that switched RTK off', () => {
  let repo: string;
  let outside: string;
  const rtk = { templateId: 'rtk.claude-settings', schemaVersion: 1, contentHash: 'h-rtk' };
  const block = `${RTK_REF_MARKER_START}\nRTK is here.\n${RTK_REF_MARKER_END}\n`;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-'));
    outside = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-out-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    inSync([claude]);
    state.rows.get(schema.templateManifestCache)!.push({
      ...rtk,
      templateKind: 'rtk-config',
      setHash: 's',
    });
    state.rows.get(schema.onboardingArtifacts)!.push({
      templateId: rtk.templateId,
      templateSchemaVersion: rtk.schemaVersion,
      templateContentHash: rtk.contentHash,
      bundleItemId: null,
      haiveVersion: null,
      generatedAt: null,
    });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const repoRow = (rtkEnabled: boolean, applicable = ['agent.x', rtk.templateId]) => {
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: applicable,
      storagePath: repo,
      localPath: null,
      rtkEnabled,
    };
  };

  it('reports an installed RTK settings file as changed once RTK is off', async () => {
    repoRow(true);
    expect((await status()).hasUpgradeAvailable).toBe(false);
    repoRow(false);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([rtk.templateId]);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('offers an upgrade for an RTK block left in a rules file once RTK is off', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), `# rules\n${block}`, 'utf8');
    repoRow(true, ['agent.x']);
    const on = await status();
    expect(on.hasUpgradeAvailable).toBe(false);
    expect(on.rtkBlockLeftovers).toBeUndefined();
    repoRow(false, ['agent.x']);
    const off = await status();
    expect(off.changedTemplateIds).toEqual([]);
    expect(off.rtkBlockLeftovers).toEqual(['AGENTS.md']);
    expect(off.hasUpgradeAvailable).toBe(true);
  });

  it('claims nothing for a block behind a link', async () => {
    await rm(path.join(repo, 'CLAUDE.md'));
    await writeFile(path.join(outside, 'CLAUDE.md'), `@AGENTS.md\n${block}`, 'utf8');
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(repo, 'CLAUDE.md'));
    repoRow(false, ['agent.x']);
    const body = await status();
    expect(body.rtkBlockLeftovers).toBeUndefined();
  });
});

describe('upgrade-status and a repository that switched RTK back on', () => {
  let repo: string;
  const claudeRtk = { templateId: 'rtk.claude-settings', schemaVersion: 1, contentHash: 'h-rtk' };
  const geminiRtk = { templateId: 'rtk.gemini-settings', schemaVersion: 1, contentHash: 'h-gem' };

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-on-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    inSync([claude]);
    for (const t of [claudeRtk, geminiRtk]) {
      state.rows.get(schema.templateManifestCache)!.push({
        ...t,
        templateKind: 'rtk-config',
        setHash: 's',
      });
    }
    // The upgrade that switched RTK off removed the settings file and wrote the snapshot without it.
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
      rtkEnabled: true,
    };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** What every live row's render-context snapshot says about RTK and the providers. */
  const snapshots = (rtkRecorded: boolean | null, providers: unknown) => {
    const rows = state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[];
    state.rows.set(
      schema.onboardingArtifacts,
      rows.map((r) => ({ ...r, rtkRecorded, snapshotProviders: providers })),
    );
  };

  it('offers the settings file the recorded providers read once RTK is back on', async () => {
    snapshots(true, [{ name: 'claude-code' }]);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([claudeRtk.templateId]);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('stays quiet with RTK off, for providers that read no file, and before RTK', async () => {
    const cases: Array<[string, boolean, boolean | null, unknown]> = [
      ['RTK off', false, true, [{ name: 'claude-code' }]],
      ['no provider reads one', true, true, [{ name: 'codex' }]],
      ['a snapshot from before RTK', true, null, [{ name: 'claude-code' }]],
    ];
    for (const [label, rtkEnabled, recorded, providers] of cases) {
      state.repo = { ...state.repo, rtkEnabled };
      snapshots(recorded, providers);
      const body = await status();
      expect(body.changedTemplateIds, label).toEqual([]);
      expect(body.hasUpgradeAvailable, label).toBe(false);
    }
  });

  it('reads the providers of the newest recorded snapshot, whatever order the rows come in', async () => {
    const rows = state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[];
    const recorded = (row: Record<string, unknown>, id: string, at: number, name: string) => ({
      ...row,
      id,
      generatedAt: new Date(at),
      rtkRecorded: true,
      snapshotProviders: [{ name }],
    });
    state.rows.set(schema.onboardingArtifacts, [
      ...rows.map((r, i) => recorded(r, `older-${i}`, 1000, 'gemini')),
      recorded(rows[0]!, 'newer', 2000, 'claude-code'),
    ]);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([claudeRtk.templateId]);
  });

  it('reads a settings file the off-upgrade kept as installed, not as missing', async () => {
    snapshots(true, [{ name: 'claude-code' }]);
    state.rows.get(schema.onboardingArtifacts)!.push({
      templateId: claudeRtk.templateId,
      templateSchemaVersion: claudeRtk.schemaVersion,
      templateContentHash: claudeRtk.contentHash,
      bundleItemId: null,
      haiveVersion: null,
      generatedAt: null,
      rtkRecorded: true,
      snapshotProviders: [{ name: 'claude-code' }],
    });
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(false);
  });
});

describe('upgrade-status and an upgrade that only removed files', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-removed-'));
    state.onboarded = false;
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: [],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
    };
    // No live row and no completed onboarding: the upgrade removed the only files a row recorded.
    state.rows = new Map<unknown, unknown[]>([
      [
        schema.templateManifestCache,
        [{ templateId: 'agent.x', schemaVersion: 1, contentHash: 'h1', setHash: 's' }],
      ],
      [schema.tasks, [{ id: 'upgrade-1', metadata: null }]],
      [schema.taskSteps, [{ output: { removedPaths: ['.claude/settings.json'] } }]],
    ]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('answers as onboarded, so the banner offers its rollback', async () => {
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasPriorUpgrade).toBe(true);
  });

  it('and while that upgrade has not finished, so the banner offers to continue it', async () => {
    state.rows.set(schema.taskSteps, []);
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasInProgressUpgradeSession).toBe(true);
    expect(body.inProgressUpgradeTaskId).toBe('upgrade-1');
  });

  // The rollback route refuses then: the step would undo the same upgrade a second time.
  it('offers no rollback once the newest completed upgrade was a rollback, live rows or not', async () => {
    state.rows.set(schema.tasks, [{ id: 'rollback-1', metadata: { mode: 'rollback' } }]);
    state.rows.set(schema.onboardingArtifacts, [
      {
        templateId: 'agent.x',
        templateSchemaVersion: 1,
        templateContentHash: 'h1',
        bundleItemId: null,
        haiveVersion: null,
        generatedAt: null,
      },
    ]);
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasPriorUpgrade).toBe(false);
  });
});

describe('upgrade-status and the RTK settings files no row records', () => {
  let repo: string;
  const settings = (text: string) => writeFile(path.join(repo, '.claude/settings.json'), text);

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-settings-'));
    await mkdir(path.join(repo, '.claude'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    state.onboarded = false;
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
      source: 'blank',
    };
    inSync([claude]);
    // Rows elsewhere, from a snapshot that recorded RTK: 01 follows the switch and probes.
    state.rows.set(
      schema.onboardingArtifacts,
      state.rows.get(schema.onboardingArtifacts)!.map((a, i) => ({
        ...(a as object),
        id: `row-${i}`,
        diskPath: `.claude/agents/row-${i}.md`,
        hasSnapshot: true,
        rtkRecorded: true,
      })),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('offers the upgrade for the settings file a blank scaffold seeded', async () => {
    await settings(buildClaudeSettingsJson());
    const body = await status();
    expect(body.rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('and for one edited around its hook', async () => {
    const edited = JSON.parse(buildClaudeSettingsJson()) as Record<string, unknown>;
    edited.theme = 'dark';
    await settings(`${JSON.stringify(edited, null, 2)}\n`);
    const body = await status();
    expect(body.rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
  });

  it('not for one past the read cap, which the plan does not read either', async () => {
    await settings(`${buildClaudeSettingsJson()}${'\n'.repeat(RULES_FILE_READ_CAP)}`);
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('not for a settings file without the hook', async () => {
    await settings('{\n  "theme": "dark"\n}\n');
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('not while RTK is on', async () => {
    await settings(buildClaudeSettingsJson());
    state.repo = { ...state.repo, rtkEnabled: true };
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  it('not for a path a live row records', async () => {
    await settings(buildClaudeSettingsJson());
    const rows = state.rows.get(schema.onboardingArtifacts)!;
    rows.push({ ...(rows[0] as object), id: 'settings-row', diskPath: '.claude/settings.json' });
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  it('not where the plan renders from snapshots that predate RTK', async () => {
    await settings(buildClaudeSettingsJson());
    state.rows.set(
      schema.onboardingArtifacts,
      state.rows
        .get(schema.onboardingArtifacts)!
        .map((a) => ({ ...(a as object), rtkRecorded: false })),
    );
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('not for a repository that was not blank and has rows of its own', async () => {
    await settings(buildClaudeSettingsJson());
    state.repo = { ...state.repo, source: 'git' };
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  it('for a repository with no rows whose onboarding recorded the choice, and not otherwise', async () => {
    await settings(buildClaudeSettingsJson());
    state.onboarded = true;
    state.repo = { ...state.repo, source: 'git' };
    state.rows.set(schema.onboardingArtifacts, []);
    state.rows.set(schema.tasks, [{ id: 'onboarding-1', metadata: null }]);
    state.rows.set(schema.taskSteps, [{ recorded: true }]);
    expect((await status()).rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
    state.rows.set(schema.taskSteps, [{ recorded: false }]);
    expect((await status()).rtkSettingsLeftovers).toBeUndefined();
  });
});

/**
 * B1.4c controls U1-U12 (design-c.md "Controls"). The hand mock above ignores every WHERE, so no case
 * here can hold a task row: the states of the onboarding verdict that need one are POST /tasks's, in
 * upgrade-gate-render-context.test.ts, which asks the same function.
 */
describe('upgrade-status and a clone holding a render context column', () => {
  const claudeRtk = { templateId: 'rtk.claude-settings', schemaVersion: 1, contentHash: 'h-rtk-c' };
  const geminiRtk = { templateId: 'rtk.gemini-settings', schemaVersion: 1, contentHash: 'h-rtk-g' };
  const portableOnly = (over: Record<string, unknown> = {}) => ({
    projectInfo: { name: 'acme' },
    framework: 'drupal',
    acceptedAgentIds: ['code-reviewer'],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkChoiceRecorded: true,
    ...over,
  });
  const fullColumn = (over: Record<string, unknown> = {}) =>
    portableOnly({
      agentTargets: [{ dir: '.gemini/agents', format: 'markdown' }],
      enabledCliProviders: [{ name: 'gemini', rulesFile: 'GEMINI.md', rulesFileMode: 'import' }],
      rtkEnabled: true,
      ...over,
    });

  let repo: string;
  const markers = async (except?: string) => {
    for (const rel of [KB_DIR, '.claude/agents', '.claude/skills']) {
      if (rel !== except) await mkdir(path.join(repo, rel), { recursive: true });
    }
    if (except !== '.claude/workflow-config.json') {
      await mkdir(path.join(repo, '.claude'), { recursive: true });
      await writeFile(path.join(repo, '.claude/workflow-config.json'), '{}\n', 'utf8');
    }
  };

  /** A clone: the sync gave it a column, and nothing else of Haive's is recorded. */
  const clone = (over: Record<string, unknown> = {}) => {
    state.onboarded = false;
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: null,
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
      source: 'git_https',
      status: 'ready',
      onboardedAt: null,
      onboardingResetAt: null,
      renderContext: portableOnly(),
      ...over,
    };
  };

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-column-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    await markers();
    inSync([claude]);
    state.rows.set(schema.onboardingArtifacts, []);
    for (const t of [claudeRtk, geminiRtk]) {
      state.rows.get(schema.templateManifestCache)!.push({
        ...t,
        templateKind: 'rtk-config',
        setHash: 's',
      });
    }
    clone();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // U1
  it('U1: is onboarded, and offers an upgrade, for a clone no row records', async () => {
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasUpgradeAvailable).toBe(true);
    expect(body.installedTemplateSetHash).toBeNull();
    expect(body.changedTemplateIds).toContain(CLI_RULES_TEMPLATE_ID);
  });

  // With every CLI off nothing incidental (the rules region, an import, RTK) can make the banner
  // offer the upgrade, and the banner is the only place one starts.
  it('U13: offers the first upgrade on this install to a clone no row records, CLIs off', async () => {
    state.rows.set(schema.cliProviders, [{ ...claude, enabled: false }]);

    const body = await status();

    expect(body.isOnboarded).toBe(true);
    expect(body.hasUpgradeAvailable).toBe(true);
    expect(body.firstUpgradeOnThisInstall).toBe(true);
  });

  // A first upgrade cancelled at 02's form writes no row, and the next one must still be offered.
  it('U13c: keeps offering the first upgrade after an upgrade that recorded no row', async () => {
    state.rows.set(schema.cliProviders, [{ ...claude, enabled: false }]);
    state.rows.set(schema.tasks, [{ id: 'upgrade-1', metadata: null }]);

    const body = await status();

    expect(body.isOnboarded).toBe(true);
    expect(body.hasUpgradeAvailable).toBe(true);
    expect(body.firstUpgradeOnThisInstall).toBe(true);
  });

  it('U13b: says nothing of a first upgrade once a row records the repository', async () => {
    inSync([claude]);
    clone();

    const body = await status();

    expect(body.firstUpgradeOnThisInstall).toBeUndefined();
  });

  // U2: the banner's half of what 01 offers on the same repository (upgrade-plan-render-context.test.ts, W2)
  it('U2: offers the RTK settings file it finds for removal once RTK is off, as the plan does', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude/settings.json'), buildClaudeSettingsJson(), 'utf8');
    await writeFile(
      path.join(repo, 'AGENTS.md'),
      `# rules\n${RTK_REF_MARKER_START}\nRTK is here.\n${RTK_REF_MARKER_END}\n`,
      'utf8',
    );
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
    expect(body.rtkBlockLeftovers).toEqual(['AGENTS.md']);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  // U3
  it("U3: adds claude's RTK template once RTK is on, for the CLIs the caller has enabled", async () => {
    clone({ rtkEnabled: true });
    const body = await status();
    expect(body.changedTemplateIds).toContain(claudeRtk.templateId);
    expect(body.changedTemplateIds).not.toContain(geminiRtk.templateId);
  });

  // U4
  it("U4: reads the providers a full column names, not the caller's", async () => {
    clone({ rtkEnabled: true, renderContext: fullColumn() });
    const body = await status();
    expect(body.changedTemplateIds).toContain(geminiRtk.templateId);
    expect(body.changedTemplateIds).not.toContain(claudeRtk.templateId);
  });

  it('U4b: reads the providers of a column that holds an empty list as none', async () => {
    clone({ rtkEnabled: true, renderContext: fullColumn({ enabledCliProviders: [] }) });
    const body = await status();
    expect(body.changedTemplateIds).not.toContain(geminiRtk.templateId);
    expect(body.changedTemplateIds).not.toContain(claudeRtk.templateId);
  });

  // U5
  it('U5: reads the column ahead of the rows: a column that recorded no RTK choice adds no RTK template', async () => {
    inSync([claude]);
    for (const t of [claudeRtk, geminiRtk]) {
      state.rows.get(schema.templateManifestCache)!.push({
        ...t,
        templateKind: 'rtk-config',
        setHash: 's',
      });
    }
    state.rows.set(
      schema.onboardingArtifacts,
      (state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[]).map((r) => ({
        ...r,
        hasSnapshot: true,
        rtkRecorded: true,
        snapshotProviders: [{ name: 'claude-code' }],
      })),
    );
    clone({
      rtkEnabled: true,
      applicableTemplateIds: ['agent.x'],
      renderContext: portableOnly({ rtkChoiceRecorded: false }),
    });
    const body = await status();
    expect(body.changedTemplateIds).not.toContain(claudeRtk.templateId);
    expect(body.changedTemplateIds).not.toContain(geminiRtk.templateId);
  });

  it('U5b: does not offer the RTK settings file a column that recorded no choice leaves, as the plan does not', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude/settings.json'), buildClaudeSettingsJson(), 'utf8');
    clone({ renderContext: portableOnly({ rtkChoiceRecorded: false }) });
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  // U6, and the states of the same verdict that need no task row
  it.each([KB_DIR, '.claude/agents', '.claude/skills', '.claude/workflow-config.json'])(
    'U6: is not onboarded with %s missing from the checkout',
    async (missing) => {
      await rm(repo, { recursive: true, force: true });
      await mkdir(repo, { recursive: true });
      await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
      await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
      await markers(missing);
      const body = await status();
      expect(body.isOnboarded).toBe(false);
      expect(body.hasUpgradeAvailable).toBe(false);
    },
  );

  it.each(['error', 'cloning'])(
    'U7: is not onboarded while the repository is %s',
    async (repoStatus) => {
      clone({ status: repoStatus });
      const body = await status();
      expect(body.isOnboarded).toBe(false);
      expect(body.hasUpgradeAvailable).toBe(false);
    },
  );

  it('U8: is not onboarded after a reset that nothing answered', async () => {
    clone({ onboardingResetAt: new Date(1000) });
    expect((await status()).isOnboarded).toBe(false);
  });

  it('U9: is onboarded again once the repository was stamped after its reset', async () => {
    clone({ onboardingResetAt: new Date(1000), onboardedAt: new Date(2000) });
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('U12: reads the local path of a repository that has no storage path', async () => {
    clone({ storagePath: null, localPath: repo });
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('U10: is not onboarded for a repository with no checkout to read', async () => {
    clone({ storagePath: null, localPath: null });
    expect((await status()).isOnboarded).toBe(false);
  });

  it.each([
    ['NULL', { renderContext: null }],
    ['absent', { renderContext: undefined }],
    ['an empty object', { renderContext: {} }],
    ['an unknown key', { renderContext: portableOnly({ somethingNew: true }) }],
    ['no rtkChoiceRecorded', { renderContext: portableOnly({ rtkChoiceRecorded: undefined }) }],
  ])('U11: is not onboarded when the column is %s', async (_name, over) => {
    clone(over);
    const body = await status();
    expect(body.isOnboarded).toBe(false);
    expect(body.hasUpgradeAvailable).toBe(false);
  });
});

/**
 * D10 (design-d's U7, renamed: B1.4c's U7 is above) and N12 (design-227.md). The sets are the worker's
 * in project-state-sync-applicable.test.ts: P is what 01 computes for the claims, D1_SET what a sync
 * that imports a teammate's agent writes in the same transaction, and TEAM2_SET what a sync that
 * drops security-auditor writes.
 */
describe('D10: upgrade-status and the set a project-state sync wrote', () => {
  const PLUGIN_JSON =
    'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json';
  const PLUGIN_LSP =
    'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json';
  const PLUGIN_MARKETPLACE =
    'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json';
  const P = [
    'agent.code-reviewer',
    'agent.security-auditor',
    'agents-index',
    'cli-rules',
    PLUGIN_JSON,
    PLUGIN_LSP,
    PLUGIN_MARKETPLACE,
    'workflow-config',
  ];
  const D1_SET = [
    'agent.code-reviewer',
    'agent.security-auditor',
    'agent.test-writer',
    'agents-index',
    'cli-rules',
    PLUGIN_JSON,
    PLUGIN_LSP,
    PLUGIN_MARKETPLACE,
    'workflow-config',
  ];
  const TEAM2_SET = [
    'agent.code-reviewer',
    'agents-index',
    'cli-rules',
    PLUGIN_JSON,
    PLUGIN_LSP,
    PLUGIN_MARKETPLACE,
    'workflow-config',
  ];
  /** Every rendering of BASE, as the worker's BASE_CLAIMS records them. */
  const CLAIMS: [string, string][] = [
    ['.claude/workflow-config.json', 'workflow-config'],
    ['.claude/agents/README.md', 'agents-index'],
    ['.codex/agents/README.md', 'agents-index'],
    ['.claude/agents/code-reviewer.md', 'agent.code-reviewer'],
    ['.codex/agents/code-reviewer.toml', 'agent.code-reviewer'],
    ['.claude/agents/security-auditor.md', 'agent.security-auditor'],
    ['.codex/agents/security-auditor.toml', 'agent.security-auditor'],
    ['.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json', PLUGIN_MARKETPLACE],
    [
      '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
      PLUGIN_JSON,
    ],
    ['.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json', PLUGIN_LSP],
    ['AGENTS.md', 'cli-rules'],
  ];
  const SA_FILES = ['.claude/agents/security-auditor.md', '.codex/agents/security-auditor.toml'];
  const recordedBody = (diskPath: string) => `${diskPath}: the body its row records\n`;
  const kindOf = (id: string) =>
    id.startsWith('agent.') ? 'agent' : id.startsWith('plugin.') ? 'plugin-file' : id;
  const owner = [
    claude,
    { ...claude, name: 'codex' },
    { ...claude, name: 'gemini', enabled: false },
  ];

  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-applicable-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    const block = buildCliRulesBlockFromProviders(owner)!;
    const artifact = (diskPath: string, templateId: string) => ({
      id: `claim-${diskPath}`,
      diskPath,
      templateId,
      templateSchemaVersion: 1,
      templateContentHash:
        templateId === CLI_RULES_TEMPLATE_ID ? sha256Hex(normalizeContent(block)) : 'h1',
      writtenHash: SA_FILES.includes(diskPath)
        ? sha256Hex(normalizeContent(recordedBody(diskPath)))
        : 'w',
      bundleItemId: null,
      haiveVersion: null,
      repositoryId: 'repo-1',
      generatedAt: new Date(1),
    });
    state.rows = new Map<unknown, unknown[]>([
      [
        schema.templateManifestCache,
        D1_SET.filter((id) => id !== CLI_RULES_TEMPLATE_ID).map((id) => ({
          templateId: id,
          templateKind: kindOf(id),
          schemaVersion: 1,
          contentHash: 'h1',
          setHash: 's',
        })),
      ],
      [schema.cliProviders, owner],
      [schema.onboardingArtifacts, CLAIMS.map(([diskPath, id]) => artifact(diskPath, id))],
    ]);
    state.onboarded = false;
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const withSet = (applicableTemplateIds: string[]) => {
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds,
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
    };
  };

  it('reads the claims against the set 01 computed as up to date', async () => {
    withSet(P);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('reads the agent a sync added to the set as changed, and offers the upgrade', async () => {
    withSet(D1_SET);
    const body = await status();
    expect(body.changedTemplateIds).toEqual(['agent.test-writer']);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('N12: reads the agent a sync dropped from the set as changed while its files hold what its rows record', async () => {
    for (const diskPath of SA_FILES) {
      await mkdir(path.dirname(path.join(repo, diskPath)), { recursive: true });
      await writeFile(path.join(repo, diskPath), recordedBody(diskPath), 'utf8');
    }
    withSet(TEAM2_SET);
    const body = await status();
    expect(body.changedTemplateIds).toEqual(['agent.security-auditor']);
    expect(body.hasUpgradeAvailable).toBe(true);
  });
});

/**
 * design-227.md Decision 1: a claim the set does not hold is reported as changed while 02 could still
 * remove one of its paths, which is when the path is absent, holds the bytes its row records, or is an
 * RTK settings file whose hook it can take out. N1, N2, N5, N6 and N8a fail without it; the rest are
 * pins. O4 is the keep choice's banner side: the claim is reported until an untrack supersedes it.
 */
describe('upgrade-status and a claim outside the applicable set', () => {
  const SA = 'agent.security-auditor';
  const SA_PATH = '.claude/agents/security-auditor.md';
  const RTK = 'rtk.claude-settings';
  const SETTINGS = '.claude/settings.json';
  // Not normalize-stable: CRLF line ends, trailing spaces and extra blank lines.
  const BODY = 'recorded body  \r\nwith CRLF line ends\r\nand trailing spaces   \r\n\r\n\r\n';
  let root: string;
  let outside: string;
  let rows = 0;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'upgrade-status-outside-'));
    outside = await mkdtemp(path.join(tmpdir(), 'upgrade-status-outside-out-'));
    await writeFile(path.join(root, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    inSync([claude]);
    state.rows.get(schema.templateManifestCache)!.push(
      {
        templateId: SA,
        templateKind: 'agent',
        schemaVersion: 1,
        contentHash: 'h-sa',
        setHash: 's',
      },
      {
        templateId: RTK,
        templateKind: 'rtk-config',
        schemaVersion: 1,
        contentHash: 'h-rtk',
        setHash: 's',
      },
    );
    state.onboarded = false;
    repoRow();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const repoRow = (over: Record<string, unknown> = {}) => {
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: root,
      localPath: null,
      source: 'git_https',
      rtkEnabled: false,
      ...over,
    };
  };

  /** A live row for a template at a path, whose recorded body is written there unless `file` says
   *  what the path holds instead (null: nothing). */
  async function claim(c: {
    templateId: string;
    diskPath: string;
    hash: string;
    body: string;
    file?: string | null;
    bundleItemId?: string | null;
  }) {
    rows += 1;
    state.rows.get(schema.onboardingArtifacts)!.push({
      id: `row-${rows}`,
      diskPath: c.diskPath,
      templateId: c.templateId,
      templateSchemaVersion: 1,
      templateContentHash: c.hash,
      writtenHash: sha256Hex(normalizeContent(c.body)),
      bundleItemId: c.bundleItemId ?? null,
      haiveVersion: null,
      generatedAt: null,
    });
    const file = c.file === undefined ? c.body : c.file;
    if (file !== null) {
      await mkdir(path.dirname(path.join(root, c.diskPath)), { recursive: true });
      await writeFile(path.join(root, c.diskPath), file, 'utf8');
    }
  }
  const reads = async () => {
    const body = await status();
    return [body.changedTemplateIds, body.hasUpgradeAvailable];
  };
  const sa = (over: { file?: string | null; body?: string } = {}) =>
    claim({ templateId: SA, diskPath: SA_PATH, hash: 'h-sa', body: BODY, ...over });
  const settings = (over: { file?: string | null } = {}) =>
    claim({
      templateId: RTK,
      diskPath: SETTINGS,
      hash: 'h-rtk',
      body: buildClaudeSettingsJson(),
      ...over,
    });
  const editedSettings = buildClaudeSettingsJson().replace('{\n', '{\n  "model": "ours",\n');

  it('N1: reports an agent the set no longer holds while its file holds the body its row records', async () => {
    expect(normalizeContent(BODY)).not.toBe(BODY);
    await sa();
    expect(await reads()).toEqual([[SA], true]);
  });

  it('N2: and while the file is gone', async () => {
    await sa({ file: null });
    expect(await reads()).toEqual([[SA], true]);
  });

  it('N5: reports an installed RTK settings file once RTK is off and the set lacks its template', async () => {
    await settings();
    expect(await reads()).toEqual([[RTK], true]);
  });

  it('N6: and one edited around the hook, which 02 can strip', async () => {
    await settings({ file: editedSettings });
    expect(await reads()).toEqual([[RTK], true]);
  });

  it('N8a: reports a template a release removed from the manifest', async () => {
    await claim({
      templateId: 'agent.retired',
      diskPath: '.claude/agents/retired.md',
      hash: 'h-r',
      body: 'retired body\n',
    });
    expect(await reads()).toEqual([['agent.retired'], true]);
  });

  it('N3: reports nothing for a file holding other bytes, which 02 keeps', async () => {
    await sa({ file: "a person's own agent\n" });
    expect(await reads()).toEqual([[], false]);
  });

  it('N4: nor for a link to a file holding the body, nor one past the read cap', async () => {
    await sa({ file: null });
    await writeFile(path.join(outside, 'sa.md'), BODY, 'utf8');
    await mkdir(path.dirname(path.join(root, SA_PATH)), { recursive: true });
    await symlink(path.join(outside, 'sa.md'), path.join(root, SA_PATH));
    expect(await reads(), 'a link').toEqual([[], false]);

    await rm(path.join(root, SA_PATH));
    state.rows.set(
      schema.onboardingArtifacts,
      state.rows.get(schema.onboardingArtifacts)!.slice(0, 2),
    );
    await sa({ body: BODY + 'x'.repeat(RULES_FILE_READ_CAP) });
    expect(await reads(), 'past the cap').toEqual([[], false]);
  });

  it('N7: nor for an RTK settings file the hook was taken out of', async () => {
    await settings({ file: '{\n  "model": "ours"\n}\n' });
    expect(await reads()).toEqual([[], false]);
  });

  it('N8b: keeps reporting a template the manifest dropped while the set still holds it', async () => {
    repoRow({ applicableTemplateIds: ['agent.x', 'agent.retired'] });
    await claim({
      templateId: 'agent.retired',
      diskPath: '.claude/agents/retired.md',
      hash: 'h-r',
      body: 'retired body\n',
    });
    expect(await reads()).toEqual([['agent.retired'], true]);
  });

  it('N9: reads a per-repository claim by its own comparison, a dangling custom one not at all', async () => {
    const custom = {
      templateId: 'custom.b1.i1',
      diskPath: '.claude/skills/x/SKILL.md',
      hash: 'h-c',
      body: 'skill body\n',
    };
    state.rows.set(schema.customBundleItems, [
      {
        itemId: 'i1',
        bundleId: 'b1',
        kind: 'skill',
        schemaVersion: 1,
        contentHash: 'h-c',
        normalizedSpec: { id: 'x', title: 'X', description: 'A skill that renders' },
      },
    ]);
    await claim({ ...custom, bundleItemId: 'i1' });
    expect(await reads(), 'a live item').toEqual([[], false]);

    state.rows.set(schema.customBundleItems, []);
    state.rows.set(
      schema.onboardingArtifacts,
      state.rows.get(schema.onboardingArtifacts)!.slice(0, 2),
    );
    await claim({ ...custom, bundleItemId: null });
    expect(await reads(), 'a dangling row').toEqual([[], false]);
  });

  it('N10: reads a NULL set as the installed templates, so nothing is outside it', async () => {
    repoRow({ applicableTemplateIds: null });
    await sa();
    expect(await reads()).toEqual([[], false]);
  });

  it('N11: looks outside the set after the RTK add-back: with RTK on its template is in it', async () => {
    repoRow({ rtkEnabled: true });
    await settings();
    state.rows.set(
      schema.onboardingArtifacts,
      (state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[]).map((r) => ({
        ...r,
        hasSnapshot: true,
        rtkRecorded: true,
        snapshotProviders: [{ name: 'claude-code' }],
      })),
    );
    expect(await reads()).toEqual([[], false]);
  });

  it('O4: reports an obsolete Haive claim while its row is live, and nothing once an untrack superseded the row', async () => {
    await sa();
    expect(await reads(), 'row live').toEqual([[SA], true]);

    // The untrack supersedes the row and leaves the file where it is.
    state.rows.set(
      schema.onboardingArtifacts,
      (state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[]).filter(
        (r) => r.templateId !== SA,
      ),
    );
    expect(await reads(), 'row superseded').toEqual([[], false]);
  });
});

/** The keep choice's rollback offer: an upgrade that only untracked a row wrote and removed nothing,
 *  and its undo is the only way to get the row back. */
describe('upgrade-status and an upgrade that only untracked a row', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-untracked-'));
    state.onboarded = false;
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: [],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
    };
    state.rows = new Map<unknown, unknown[]>([
      [
        schema.templateManifestCache,
        [{ templateId: 'agent.x', schemaVersion: 1, contentHash: 'h1', setHash: 's' }],
      ],
      [schema.tasks, [{ id: 'upgrade-1', metadata: null }]],
      [schema.taskSteps, [{ output: { untrackedRowIds: ['row-1'] } }]],
    ]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('O6: offers its rollback', async () => {
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasPriorUpgrade).toBe(true);
  });

  it('offers none for an upgrade that untracked, wrote and removed nothing', async () => {
    state.rows.set(schema.taskSteps, [{ output: { untrackedRowIds: [], removedPaths: [] } }]);
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasPriorUpgrade).toBe(false);
  });
});

// #165, #166, the banner's half: a reset and a live onboarding withdraw the offer whatever rows remain.
// The hand mock ignores every WHERE, so the one set of task rows below answers each task query.
describe('upgrade-status honours a reset and a live onboarding', () => {
  const RESET = 5000;
  let repo: string;

  const onboarding = (over: Record<string, unknown> = {}) => ({
    id: 'onboarding-1',
    repositoryId: 'repo-1',
    type: 'onboarding',
    status: 'completed',
    completedAt: new Date(1000),
    metadata: null,
    ...over,
  });

  /** The repository, its tasks and its live rows (all written at `rowsAt`, none when null). */
  const world = (over: {
    resetAt?: number;
    tasks?: Record<string, unknown>[];
    rowsAt?: number | null;
  }) => {
    inSync([claude]);
    const rowsAt = over.rowsAt === undefined ? 1000 : over.rowsAt;
    state.rows.set(
      schema.onboardingArtifacts,
      rowsAt === null
        ? []
        : (state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[]).map((r) => ({
            ...r,
            repositoryId: 'repo-1',
            generatedAt: new Date(rowsAt),
          })),
    );
    state.rows.set(schema.tasks, over.tasks ?? []);
    state.onboarded = (over.tasks ?? []).some((t) => t.status === 'completed');
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
      source: 'git_https',
      status: 'ready',
      onboardedAt: null,
      onboardingResetAt: over.resetAt === undefined ? null : new Date(over.resetAt),
    };
  };

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-reset-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const notOnboarded = async () => {
    const body = await status();
    expect(body.isOnboarded).toBe(false);
    expect(body.hasUpgradeAvailable).toBe(false);
  };

  it('is onboarded where nothing was reset and a row is live', async () => {
    world({});
    expect((await status()).isOnboarded).toBe(true);
  });

  it('is not onboarded after a reset when the rows it kept are all that remain', async () => {
    world({ resetAt: RESET, tasks: [onboarding()], rowsAt: 1000 });
    await notOnboarded();
  });

  it('is not onboarded after a reset when only a completion from before it remains', async () => {
    world({ resetAt: RESET, tasks: [onboarding()], rowsAt: null });
    await notOnboarded();
  });

  it('is onboarded once an onboarding completed after the reset', async () => {
    world({ resetAt: RESET, tasks: [onboarding({ completedAt: new Date(6000) })], rowsAt: null });
    expect((await status()).isOnboarded).toBe(true);
  });

  it('is onboarded once rows were written after the reset', async () => {
    world({ resetAt: RESET, rowsAt: 6000 });
    expect((await status()).isOnboarded).toBe(true);
  });

  it.each(['running', 'waiting_user'])(
    'is not onboarded while an onboarding is %s, whatever rows remain',
    async (taskStatus) => {
      world({ tasks: [onboarding(), onboarding({ id: 'onboarding-2', status: taskStatus })] });
      await notOnboarded();
    },
  );

  it('is not onboarded after a reset because an upgrade once ran', async () => {
    world({
      resetAt: RESET,
      tasks: [onboarding({ id: 'upgrade-1', type: 'onboarding_upgrade', status: 'failed' })],
      rowsAt: null,
    });
    await notOnboarded();
  });
});

// #235: 01 skips a bundle item whose spec fails its loader's schema, so a live row for it is offered
// as obsolete, while the banner counted every item as current.
describe('upgrade-status and a bundle item 01 cannot render', () => {
  const GOOD_SKILL = { id: 'good', title: 'Good', description: 'A skill that renders' };
  const GOOD_AGENT = {
    id: 'agent-ok',
    title: 'Agent',
    description: 'An agent that renders',
    color: 'blue',
    field: 'qa',
    tools: [],
    coreMission: 'Review',
    responsibilities: [],
    whenInvoked: [],
    executionSteps: [],
    outputFormat: '',
    qualityCriteria: [],
    antiPatterns: [],
  };
  let repo: string;

  const item = (itemId: string, kind: 'agent' | 'skill', spec: Record<string, unknown>) => ({
    itemId,
    bundleId: 'b1',
    kind,
    schemaVersion: 1,
    contentHash: 'h-c',
    normalizedSpec: spec,
  });
  /** A live row for the item, current as far as its hash goes. */
  const row = (itemId: string, kind: 'agent' | 'skill') => ({
    id: `row-${itemId}`,
    diskPath: `.claude/${kind}s/${itemId}.md`,
    templateId: `custom.b1.${itemId}`,
    templateSchemaVersion: 1,
    templateContentHash: kind === 'agent' ? bundleAgentTemplateHash('h-c') : 'h-c',
    writtenHash: 'w',
    bundleItemId: itemId,
    haiveVersion: null,
    repositoryId: 'repo-1',
    generatedAt: new Date(1000),
  });
  const world = (items: ReturnType<typeof item>[], live: [string, 'agent' | 'skill'][]) => {
    inSync([claude]);
    state.rows.set(schema.onboardingArtifacts, [
      ...(state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[]).map((r) => ({
        ...r,
        repositoryId: 'repo-1',
        generatedAt: new Date(1000),
      })),
      ...live.map(([itemId, kind]) => row(itemId, kind)),
    ]);
    state.rows.set(schema.customBundleItems, items);
    state.rows.set(schema.customBundles, [{ name: 'House bundle' }]);
    state.onboarded = false;
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
    };
  };

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-bundle-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reads installed items that render as current', async () => {
    world(
      [item('good', 'skill', GOOD_SKILL), item('agent-ok', 'agent', GOOD_AGENT)],
      [
        ['good', 'skill'],
        ['agent-ok', 'agent'],
      ],
    );
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it.each([
    ['skill', 'skill', { id: 'bad-one' }],
    ['agent', 'agent', { ...GOOD_AGENT, id: 'bad-one', coreMission: '' }],
  ] as const)(
    'reports an installed %s whose spec fails the schema as changed',
    async (_k, kind, spec) => {
      world(
        [item('good', 'skill', GOOD_SKILL), item('bad-one', kind, spec)],
        [
          ['good', 'skill'],
          ['bad-one', kind],
        ],
      );
      const body = await status();
      expect(body.changedTemplateIds).toEqual(['custom.b1.bad-one']);
      expect(body.hasUpgradeAvailable).toBe(true);
      expect(body.customChanges).toEqual([
        { bundleId: 'b1', bundleName: 'House bundle', changedItemCount: 1 },
      ]);
    },
  );

  it('reports nothing for an item that fails the schema and was never installed', async () => {
    world(
      [item('good', 'skill', GOOD_SKILL), item('bad-one', 'skill', { id: 'bad-one' })],
      [['good', 'skill']],
    );
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('still reads a valid item with no live row as a new one to install', async () => {
    world([item('good', 'skill', GOOD_SKILL)], []);
    const body = await status();
    expect(body.changedTemplateIds).toEqual(['custom.b1.good']);
    expect(body.hasUpgradeAvailable).toBe(true);
  });
});
