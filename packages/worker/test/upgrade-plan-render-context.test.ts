import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { buildClaudeSettingsJson } from '@haive/shared';
import * as projectState from '@haive/shared/project-state';
import { renderTargetsFor } from '../src/step-engine/_render-targets.js';
import {
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  expandManifestFor,
  type TemplateRenderContext,
} from '../src/step-engine/template-manifest.js';
import {
  PROVIDERS,
  RTK_BLOCK,
  ctxFor,
  newDb,
  seedLiveRow,
  seedOnboarding,
  seedProviders,
  seedRepository,
  type Fake,
  type LoggerCalls,
  type ProviderSeed,
} from './support/upgrade-plan-fixtures.js';
import { detect07, rowSnapshot } from './support/upgrade-plan-grid.js';

/** The names this change adds to @haive/shared/project-state, looked up so that a missing one is
 *  what fails. */
function added<T>(name: string): T {
  const value = (projectState as unknown as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@haive/shared/project-state does not export ${name}`);
  return value as T;
}

/**
 * B1.4c controls W1-W9 (design-c.md "Controls"): 01 plans from `repositories.render_context` ahead of
 * every live row and every task, completes a column that holds the portable fields alone from the
 * upgrading user's enabled CLIs (and nothing else), and takes its RTK choice from the stored
 * `rtkChoiceRecorded`. W8 and W9, and the b/c variants, are the harness's own readings of the design.
 */

const CUSTOM = {
  id: 'billing-expert',
  description: 'Knows the billing module',
  title: 'Billing expert',
  color: 'blue',
  tools: ['Read'],
};
const PORTABLE = () => ({
  projectInfo: { name: 'acme-column', framework: 'drupal', docroot: 'web' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer', 'billing-expert'],
  customAgentSpecs: [CUSTOM],
  lspLanguages: ['php-extended'],
});
/** What the sync writes into a clone's column: the five portable fields and the stored RTK flag. */
const portableOnly = (over: Record<string, unknown> = {}) => ({
  ...PORTABLE(),
  rtkChoiceRecorded: true,
  ...over,
});
const CLAUDE_IMPORT = { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' };
const CODEX_NATIVE = { name: 'codex', rulesFile: 'AGENTS.md', rulesFileMode: 'native' };
/** What a writer (12, 02, 04) records: every per-install field too. */
const fullColumn = (over: Record<string, unknown> = {}) => ({
  ...PORTABLE(),
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  enabledCliProviders: [CLAUDE_IMPORT],
  rtkEnabled: true,
  rtkChoiceRecorded: true,
  ...over,
});

const CONTEXT_KEYS = [
  'acceptedAgentIds',
  'agentTargets',
  'customAgentSpecs',
  'enabledCliProviders',
  'framework',
  'lspLanguages',
  'projectInfo',
  'rtkEnabled',
];
const DETECT_KEYS = [
  'counts',
  'currentTemplateSetHash',
  'entries',
  'installedTemplateSetHash',
  'missingRulesImports',
  'ranBackfill',
  'renderCtxSnapshot',
  'repositoryId',
  'rtkBlockLeftovers',
  'rtkFollowsLive',
];

/** What 07 derives for claude-code, codex on and gemini off, with `php-extended` configured. */
const DERIVED_TARGETS = [
  { dir: '.claude/agents', format: 'markdown', supportsLsp: true },
  { dir: '.codex/agents', format: 'toml', supportsLsp: false },
];
const DERIVED_PROVIDERS = [CLAUDE_IMPORT, CODEX_NATIVE];

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'upgrade-plan-render-context-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

interface Setup {
  column: unknown;
  source?: string;
  /** The repository's live RTK switch. */
  live?: boolean;
  providers?: ProviderSeed[];
  seed?: (fake: Fake) => void;
  logs?: LoggerCalls;
}

function planOf(setup: Setup) {
  const fake = newDb();
  seedProviders(fake, setup.providers);
  seedRepository(fake, {
    source: setup.source ?? 'git_https',
    rtkEnabled: setup.live ?? true,
    renderContext: setup.column,
  });
  setup.seed?.(fake);
  const ctx = ctxFor(fake, repo, setup.logs);
  return {
    fake,
    ctx,
    detect: () => upgradePlanStep.detect!(ctx),
    apply: (detected: UpgradePlanDetect) =>
      upgradePlanStep.apply(ctx, {
        detected,
        formValues: {},
        iteration: 0,
        previousIterations: [],
      }),
  };
}

const rtkEntries = (d: UpgradePlanDetect) =>
  d.entries
    .filter((e) => e.templateKind === 'rtk-config')
    .map((e) => ({ diskPath: e.diskPath, bucket: e.bucket }));

describe('01 plans from a portable-only column', () => {
  // W1
  it('W1: completes the per-install fields from the upgrading user enabled CLIs, and renders RTK live', async () => {
    const detected = await planOf({ column: portableOnly() }).detect();

    expect(detected.renderCtxSnapshot).toEqual({
      ...PORTABLE(),
      agentTargets: DERIVED_TARGETS,
      enabledCliProviders: DERIVED_PROVIDERS,
      rtkEnabled: true,
    });
    expect(Object.keys(detected.renderCtxSnapshot).sort()).toEqual(CONTEXT_KEYS);
    expect('rtkChoiceRecorded' in detected.renderCtxSnapshot).toBe(false);
    expect(detected.rtkFollowsLive).toBe(true);
    // No field is added to what a plan persists.
    expect(Object.keys(detected).sort()).toEqual(DETECT_KEYS);
    // What 07 itself derives for the same rows and languages: gemini, which is off, is in neither.
    const derived = renderTargetsFor(
      PROVIDERS as unknown as Parameters<typeof renderTargetsFor>[0],
      PORTABLE().lspLanguages,
    );
    expect(detected.renderCtxSnapshot.agentTargets).toEqual(derived.agentTargets);
    expect(detected.renderCtxSnapshot.enabledCliProviders).toEqual(derived.enabledCliProviders);
  });

  it('W1b: takes the user enabled CLIs as they are now, not from the catalog', async () => {
    const claudeOnly: ProviderSeed[] = [
      { name: 'claude-code', enabled: true },
      { name: 'codex', enabled: false },
      { name: 'gemini', enabled: false },
    ];
    const detected = await planOf({ column: portableOnly(), providers: claudeOnly }).detect();
    expect(detected.renderCtxSnapshot.agentTargets).toEqual([DERIVED_TARGETS[0]]);
    expect(detected.renderCtxSnapshot.enabledCliProviders).toEqual([CLAUDE_IMPORT]);
  });

  // W2
  it('W2: offers the RTK settings file it finds for removal once RTK is off, and the block left in AGENTS.md', async () => {
    await mkdir(join(repo, '.claude'));
    await writeFile(join(repo, '.claude/settings.json'), buildClaudeSettingsJson(), 'utf8');
    await writeFile(join(repo, 'AGENTS.md'), `# rules\n${RTK_BLOCK}`, 'utf8');
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');

    const detected = await planOf({ column: portableOnly(), live: false }).detect();

    expect(detected.renderCtxSnapshot.rtkEnabled).toBe(false);
    expect(detected.rtkFollowsLive).toBe(true);
    expect(rtkEntries(detected)).toEqual([
      { diskPath: '.claude/settings.json', bucket: 'obsolete' },
    ]);
    expect(detected.rtkBlockLeftovers).toEqual(['AGENTS.md']);
  });

  // W8: not in the design's list; its reading of "nothing is left missing" for a column that chose nothing.
  it('W8: keeps RTK off, and the context whole, for a column that recorded no choice', async () => {
    const detected = await planOf({
      column: portableOnly({ rtkChoiceRecorded: false }),
      live: true,
    }).detect();

    expect(Object.keys(detected.renderCtxSnapshot).sort()).toEqual(CONTEXT_KEYS);
    expect(detected.renderCtxSnapshot.rtkEnabled).toBe(false);
    expect(detected.rtkFollowsLive).toBe(false);
    expect(rtkEntries(detected)).toEqual([]);
  });
});

describe('01 reads the column ahead of every other source', () => {
  const ROW_DJANGO = { ...rowSnapshot('django', true), acceptedAgentIds: ['security-auditor'] };
  const FULL = () => fullColumn({ acceptedAgentIds: ['code-reviewer'] });
  const WANT = () => ({
    projectInfo: PORTABLE().projectInfo,
    framework: 'drupal',
    acceptedAgentIds: ['code-reviewer'],
    customAgentSpecs: [],
    agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
    lspLanguages: ['php-extended'],
    rtkEnabled: true,
    enabledCliProviders: [CLAUDE_IMPORT],
  });

  // W3
  it('W3: renders from the column, not from a live row that recorded another context', async () => {
    const detected = await planOf({
      column: FULL(),
      seed: (fake) =>
        seedLiveRow(fake, { path: '.claude/agents/row-0.md', snapshot: ROW_DJANGO, at: 1000 }),
    }).detect();
    expect(detected.renderCtxSnapshot).toEqual(WANT());
  });

  it('W3b: and not from the step 07 output of a completed onboarding', async () => {
    const detected = await planOf({
      column: FULL(),
      seed: (fake) => seedOnboarding(fake, detect07('history-recorded', true)),
    }).detect();
    expect(detected.renderCtxSnapshot).toEqual(WANT());
  });

  it('W3c: and not from the context a blank repository would have built', async () => {
    const detected = await planOf({ column: FULL(), source: 'blank' }).detect();
    expect(detected.renderCtxSnapshot).toEqual(WANT());
  });

  // W4
  it('W4: takes the RTK choice from the stored flag, not from whether the column holds rtkEnabled', async () => {
    const detected = await planOf({
      column: fullColumn({ rtkEnabled: false, rtkChoiceRecorded: false }),
      live: true,
      seed: (fake) =>
        seedLiveRow(fake, {
          path: '.claude/agents/row-0.md',
          snapshot: rowSnapshot('rows-recorded', false),
          at: 1000,
        }),
    }).detect();

    expect(detected.rtkFollowsLive).toBe(false);
    expect(detected.renderCtxSnapshot.rtkEnabled).toBe(false);
    expect(rtkEntries(detected)).toEqual([]);
  });

  it('W4b: follows the live switch for a full column that recorded its choice, whatever it holds', async () => {
    for (const held of [true, false]) {
      for (const live of [true, false]) {
        const detected = await planOf({
          column: fullColumn({ rtkEnabled: held, rtkChoiceRecorded: true }),
          live,
        }).detect();
        expect({ held, live, follows: detected.rtkFollowsLive }).toEqual({
          held,
          live,
          follows: true,
        });
        expect({ held, live, rtk: detected.renderCtxSnapshot.rtkEnabled }).toEqual({
          held,
          live,
          rtk: live,
        });
      }
    }
  });
});

describe('01 completes only what the column does not hold', () => {
  const USER_CLAUDE: ProviderSeed[] = [
    { name: 'claude-code', enabled: true },
    { name: 'codex', enabled: false },
  ];
  const CODEX_TARGET = { dir: '.codex/agents', format: 'toml', supportsLsp: false };

  // W5
  it('W5: keeps a codex target a full column holds while the user now has only claude', async () => {
    const detected = await planOf({
      column: fullColumn({ agentTargets: [CODEX_TARGET], enabledCliProviders: [CODEX_NATIVE] }),
      providers: USER_CLAUDE,
    }).detect();
    expect(detected.renderCtxSnapshot.agentTargets).toEqual([CODEX_TARGET]);
    expect(detected.renderCtxSnapshot.enabledCliProviders).toEqual([CODEX_NATIVE]);
  });

  it('W5b: keeps a per-install list that is empty, whatever the user has', async () => {
    const detected = await planOf({
      column: fullColumn({ agentTargets: [], enabledCliProviders: [] }),
    }).detect();
    expect(detected.renderCtxSnapshot.agentTargets).toEqual([]);
    expect(detected.renderCtxSnapshot.enabledCliProviders).toEqual([]);
  });

  it('W5c: completes a field the column lacks beside one it holds, each on its own', async () => {
    const column = (drop: 'agentTargets' | 'enabledCliProviders') => {
      const c = fullColumn({
        agentTargets: [CODEX_TARGET],
        enabledCliProviders: [CODEX_NATIVE],
      }) as Record<string, unknown>;
      delete c[drop];
      return c;
    };

    const targetsLacking = await planOf({
      column: column('agentTargets'),
      providers: USER_CLAUDE,
    }).detect();
    expect(targetsLacking.renderCtxSnapshot.agentTargets).toEqual([DERIVED_TARGETS[0]]);
    expect(targetsLacking.renderCtxSnapshot.enabledCliProviders).toEqual([CODEX_NATIVE]);

    const providersLacking = await planOf({
      column: column('enabledCliProviders'),
      providers: USER_CLAUDE,
    }).detect();
    expect(providersLacking.renderCtxSnapshot.agentTargets).toEqual([CODEX_TARGET]);
    expect(providersLacking.renderCtxSnapshot.enabledCliProviders).toEqual([CLAUDE_IMPORT]);
  });

  // W6
  it('W6: names the same providers as the shared helper the banner reads', async () => {
    const namesOf = added<(column: unknown, enabled: string[]) => string[]>(
      'renderContextProviderNames',
    );
    const enabled = PROVIDERS.filter((p) => p.enabled).map((p) => p.name);
    const names = (d: UpgradePlanDetect) =>
      (d.renderCtxSnapshot.enabledCliProviders as { name: string }[]).map((p) => p.name).sort();

    const bare = portableOnly();
    expect(names(await planOf({ column: bare }).detect())).toEqual(
      [...namesOf(bare, enabled)].sort(),
    );
    const own = fullColumn({ enabledCliProviders: [CODEX_NATIVE] });
    expect(names(await planOf({ column: own }).detect())).toEqual(
      [...namesOf(own, enabled)].sort(),
    );
    const none = fullColumn({ enabledCliProviders: [] });
    expect(names(await planOf({ column: none }).detect())).toEqual(
      [...namesOf(none, enabled)].sort(),
    );
  });
});

describe('the upgrade backfills a clone from the completed context', () => {
  const COMPLETED = {
    ...PORTABLE(),
    agentTargets: DERIVED_TARGETS,
    enabledCliProviders: DERIVED_PROVIDERS,
    rtkEnabled: true,
  };
  // Every file the completed context renders, and the templates that render them (cli-rules is the
  // per-repository one, which has no file here: AGENTS.md carries no region).
  const WRITTEN_PATHS = [
    '.claude/agents/README.md',
    '.claude/agents/code-reviewer.md',
    '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
    '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
    '.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
    '.claude/settings.json',
    '.claude/workflow-config.json',
    '.codex/agents/README.md',
    '.codex/agents/code-reviewer.toml',
  ];
  const APPLICABLE_IDS = [
    'agent.code-reviewer',
    'agents-index',
    'cli-rules',
    'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
    'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
    'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
    'rtk.claude-settings',
    'workflow-config',
  ];

  // W7
  it('W7: records each file already there with the 8-key context, and applies from the same context', async () => {
    // What A would have written: every file the completed context renders.
    for (const r of expandManifestFor(COMPLETED as unknown as TemplateRenderContext)) {
      await mkdir(dirname(join(repo, r.diskPath)), { recursive: true });
      await writeFile(join(repo, r.diskPath), r.content, 'utf8');
    }
    const plan = planOf({ column: portableOnly() });

    const detected = await plan.detect();
    expect(detected.ranBackfill).toBe(true);
    const out = await plan.apply(detected);

    const rows = plan.fake.rows(schema.onboardingArtifacts);
    expect(out.backfilledRows).toBe(rows.length);
    expect(rows.map((r) => r.diskPath).sort()).toEqual(WRITTEN_PATHS);
    for (const row of rows) {
      expect({ path: row.diskPath, snapshot: row.formValuesSnapshot }).toEqual({
        path: row.diskPath,
        snapshot: COMPLETED,
      });
      expect(row.source).toBe('backfill');
    }
    expect(plan.fake.rows(schema.repositories)[0]!.applicableTemplateIds).toEqual(APPLICABLE_IDS);
    expect(await readFile(join(repo, '.claude/workflow-config.json'), 'utf8')).toContain('drupal');
  });
});

describe('01 reads a refused column as NULL, and says so', () => {
  const rowsRecorded = (fake: Fake) =>
    seedLiveRow(fake, {
      path: '.claude/agents/row-0.md',
      snapshot: rowSnapshot('rows-recorded', true),
      at: 1000,
    });
  const warned = (logs: LoggerCalls) => logs.calls.filter((c) => c.level === 'warn');

  // W9: not in the design's list; Decision 2 says 01 logs a refused column.
  it.each([
    ['an empty object', {}],
    ['an unknown key', portableOnly({ somethingNew: true })],
    ['no rtkChoiceRecorded', fullColumn({ rtkChoiceRecorded: undefined })],
  ])(
    'W9: warns once it is refused: %s, and plans from the rows as it would for NULL',
    async (_n, column) => {
      const logs: LoggerCalls = { calls: [] };
      const detected = await planOf({ column, seed: rowsRecorded, logs }).detect();
      expect(detected.renderCtxSnapshot.framework).toBe('rows-recorded');
      expect(warned(logs).length).toBeGreaterThan(0);
      expect(JSON.stringify(logs.calls)).toMatch(/render/i);
    },
  );

  it('W9b: does not warn for a NULL column', async () => {
    const logs: LoggerCalls = { calls: [] };
    await planOf({ column: null, seed: rowsRecorded, logs }).detect();
    expect(warned(logs)).toEqual([]);
  });

  it('W9c: does not warn for a column it reads', async () => {
    const logs: LoggerCalls = { calls: [] };
    await planOf({ column: portableOnly(), logs }).detect();
    expect(warned(logs)).toEqual([]);
  });
});
