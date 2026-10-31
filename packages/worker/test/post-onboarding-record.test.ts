import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  buildRepoCliRulesBlock,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_ID,
  extractRegion,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { namesGitData } from '@haive/shared/project-state';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { recordWritten } from './support/upgrade-apply-record.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const RECORD_FORMAT = '.haive-data/state/format.json';
const RECORD_RENDER = '.haive-data/state/project/render.json';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** What step 07 detected: the render context it leaves for 12, and the providers whose rules it wrote. */
const DETECT = {
  ...(REFERENCE_CONTEXT as unknown as Record<string, unknown>),
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  language: 'php',
  projectName: 'acme',
  cliProviders: [],
  plannedAgents: [],
  existingFiles: [],
  mcpSettingsJson: '{}',
};

/** Step 12 on a repository onboarded with the DETECT above, whose artifact recording is made to fail
 *  after the render context exists: the database refuses the artifact rows. */
async function setup(
  failure: 'none' | 'artifact-rows',
  detect: Record<string, unknown> = DETECT,
  rules: {
    /** What 07's apply returned. */
    output?: Record<string, unknown>;
    /** `repositories.agent_rules_override` as it stands when 12 runs. */
    liveOverride?: string | null;
    /** The AGENTS.md on disk. */
    agentsMd?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'post-onboarding-record-'));
  dirs.push(root);
  if (rules.agentsMd !== undefined) await writeFile(join(root, 'AGENTS.md'), rules.agentsMd);
  // No plan tables: the plan mirror warns and the record does not depend on it.
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    users: schema.users,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'upload',
    agentRulesOverride: rules.liveOverride ?? null,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    status: 'running',
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-generate-files',
    stepIndex: 7,
    round: 0,
    title: 'Generate files',
    status: 'done',
    detectOutput: detect,
    ...(rules.output ? { output: rules.output } : {}),
  });
  if (failure === 'artifact-rows') {
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.onboardingArtifacts) throw new Error('database refused');
    };
  }
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const apply = () =>
    postOnboardingStep.apply(ctx, {
      detected: {
        hasGit: false,
        hasOrigin: false,
        originUrl: null,
        boundCredentialId: null,
        credentials: [],
      },
      formValues: { commit: false },
    } as never);
  const applyCommit = () =>
    postOnboardingStep.apply(ctx, {
      detected: { hasGit: true, hasOrigin: false, credentials: [] },
      formValues: { commit: true, commitMessage: 'onboard' },
    } as never);
  return {
    root,
    fake,
    apply,
    applyCommit,
    liveRows: () => fake.rows(schema.onboardingArtifacts).filter((r) => r.supersededAt == null),
    column: () => fake.rows(schema.repositories)[0]!.renderContext ?? null,
    syncRows: () => fake.rows(schema.projectStateSync),
  };
}

describe('12 writes the project state record whatever the artifact recording did', () => {
  it('writes it, and the artifact rows, when nothing fails', async () => {
    const s = await setup('none');

    const out = await recordWritten(s.apply());

    expect(out.warnings.filter((w) => w.includes('onboarding-artifacts'))).toEqual([]);
    expect(out.artifactRowsWritten).toBeGreaterThan(0);
    expect(existsSync(join(s.root, RECORD_FORMAT))).toBe(true);
    expect(existsSync(join(s.root, RECORD_RENDER))).toBe(true);
    expect(s.column()).toMatchObject({
      framework: 'drupal',
      acceptedAgentIds: DETECT.acceptedAgentIds,
      rtkChoiceRecorded: true,
    });
    expect(s.syncRows()).toHaveLength(1);
  });

  it('writes it when the database refuses the artifact rows', async () => {
    const s = await setup('artifact-rows');

    const out = await recordWritten(s.apply());

    // The recording failed, after the context it derives from 07's output existed.
    expect(out.warnings).toContain('onboarding-artifacts recording failed: database refused');
    // Soft, so that a written record shows every missing file, column value, and sync row.
    for (const rel of [RECORD_FORMAT, RECORD_RENDER]) {
      expect.soft(existsSync(join(s.root, rel)), rel).toBe(true);
    }
    expect.soft(s.column()).toMatchObject({
      framework: 'drupal',
      acceptedAgentIds: DETECT.acceptedAgentIds,
      rtkChoiceRecorded: true,
    });
    expect.soft(s.syncRows()).toHaveLength(1);
  });

  it('records no RTK choice for a 07 output from before RTK shipped', async () => {
    const preRtk: Record<string, unknown> = { ...DETECT };
    delete preRtk.rtkEnabled;
    const s = await setup('none', preRtk);

    await recordWritten(s.apply());

    expect(s.column()).toMatchObject({ rtkEnabled: false, rtkChoiceRecorded: false });
  });
});

describe('12 records the cli-rules region from the override 07 wrote it from', () => {
  const hashOf = (text: string) => sha256Hex(normalizeContent(text));
  const regionOf = (override: string | null) => buildRepoCliRulesBlock(override) as string;
  const agentsMd = (override: string | null) =>
    `# Project\n\n${regionOf(override)}\nNotes of our own.\n`;
  const cliRulesRows = (s: Awaited<ReturnType<typeof setup>>) =>
    s.liveRows().filter((r) => r.templateId === CLI_RULES_TEMPLATE_ID);

  it('records the region 07 wrote though the live override moved since, and says nothing of it', async () => {
    const s = await setup('none', DETECT, {
      output: { wroteFiles: [], skippedFiles: [], agentRulesOverride: '- the rule 07 wrote' },
      liveOverride: '- a rule set after 07',
      agentsMd: agentsMd('- the rule 07 wrote'),
    });

    const out = await recordWritten(s.apply());

    expect(out.artifactRowsWritten).toBeGreaterThan(0);
    expect(out.warnings.filter((w) => w.includes('onboarding-artifacts'))).toEqual([]);
    const [row, ...more] = cliRulesRows(s);
    expect(more).toEqual([]);
    const onDisk = extractRegion(
      await readFile(join(s.root, 'AGENTS.md'), 'utf8'),
      CLI_RULES_START,
      CLI_RULES_END,
    );
    expect(onDisk).not.toBeNull();
    expect(row).toMatchObject({
      diskPath: 'AGENTS.md',
      source: 'onboarding',
      writtenHash: hashOf(onDisk!),
      templateContentHash: hashOf(onDisk!),
    });
    expect(row!.writtenHash).toBe(hashOf(regionOf('- the rule 07 wrote')));
  });

  it('reads the default rules from an output that carries no override', async () => {
    const s = await setup('none', DETECT, {
      output: { wroteFiles: [], skippedFiles: [] },
      liveOverride: '- a rule set after 07',
      agentsMd: agentsMd(null),
    });

    await recordWritten(s.apply());

    expect(cliRulesRows(s).map((r) => r.writtenHash)).toEqual([hashOf(regionOf(null))]);
  });

  it('records no region for an empty override, and leaves a region standing there unclaimed', async () => {
    const s = await setup('none', DETECT, {
      output: { wroteFiles: [], skippedFiles: [], agentRulesOverride: '' },
      liveOverride: '- a rule set after 07',
      agentsMd: agentsMd(null),
    });

    const out = await recordWritten(s.apply());

    expect(out.artifactRowsWritten).toBeGreaterThan(0);
    expect(cliRulesRows(s)).toEqual([]);
  });
});

describe('12 records no artifact row at a path that names git data', () => {
  const BUNDLE = '00000000-0000-4000-8000-0000000000e1';
  const BUNDLE_AGENT = {
    id: 'billing',
    title: 'Billing',
    description: 'Billing agent',
    color: 'blue',
    field: 'billing',
    tools: [],
    coreMission: 'Bill',
    responsibilities: [],
    whenInvoked: [],
    executionSteps: [],
    outputFormat: '',
    qualityCriteria: [],
    antiPatterns: [],
  };

  it('records no row at a git-data agent target, says so, and still records the ordinary ones', async () => {
    const s = await setup('none', {
      ...DETECT,
      agentTargets: [
        { dir: '.git/hooks', format: 'markdown', supportsLsp: true },
        ...REFERENCE_CONTEXT.agentTargets,
      ],
    });
    s.fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'acme-kit',
      sourceType: 'zip',
      storageRoot: '/bundles/acme-kit',
    });
    s.fake.insert(schema.customBundleItems, {
      bundleId: BUNDLE,
      kind: 'agent',
      sourceFormat: 'claude-md',
      sourcePath: 'agents/billing.md',
      normalizedSpec: BUNDLE_AGENT,
      contentHash: 'c'.repeat(64),
      schemaVersion: 1,
    });

    const out = await recordWritten(s.apply());

    const paths = s.fake.rows(schema.onboardingArtifacts).map((r) => r.diskPath as string);
    expect(paths.filter(namesGitData)).toEqual([]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '.claude/agents/code-reviewer.md',
        '.claude/agents/README.md',
        '.claude/agents/billing.md',
      ]),
    );
    expect(out.artifactRowsWritten).toBe(paths.length);
    for (const refused of [
      '.git/hooks/code-reviewer.md',
      '.git/hooks/README.md',
      '.git/hooks/billing.md',
    ]) {
      expect(
        out.warnings.some((w) => w.includes(refused)),
        refused,
      ).toBe(true);
    }
  });
});

describe('12 reports what its record write did', () => {
  it('written, when the record is written', async () => {
    const s = await setup('none');

    const out = await recordWritten(s.apply());

    expect(out.recordWrite).toBe('written');
  });

  it('failed, when the write is refused', async () => {
    const s = await setup('none');
    let refused = false;
    let domainLocks = 0;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && ++domainLocks > 1 && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await recordWritten(s.apply(), { recordWriteFails: true });

    expect(out.recordWrite).toBe('failed');
  });

  it('skipped, when 07 left no render context', async () => {
    const s = await setup('none', null as unknown as Record<string, unknown>);

    const out = await s.apply();

    expect(out.recordWrite).toBe('skipped');
  });
});

describe('12 commits the artifact claims it wrote into the record', () => {
  const git = promisify(execFile);

  it('holds a claim file per live artifact row in its commit', async () => {
    const s = await setup('none');
    await git('git', ['-C', s.root, 'init', '-q', '-b', 'main']);
    await git('git', ['-C', s.root, 'config', 'user.email', 't@example.com']);
    await git('git', ['-C', s.root, 'config', 'user.name', 'T']);
    await git('git', ['-C', s.root, 'config', 'gc.auto', '0']);
    await writeFile(join(s.root, 'README.md'), 'hi\n');
    await git('git', ['-C', s.root, 'add', 'README.md']);
    await git('git', ['-C', s.root, 'commit', '-qm', 'seed']);

    const out = await recordWritten(s.applyCommit());

    expect(out.commitPerformed).toBe(true);
    const tree = (await git('git', ['-C', s.root, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout
      .split('\n')
      .filter(Boolean);
    const claims = tree.filter((p) => /^\.haive-data\/state\/artifacts\/.+\.json$/.test(p));
    expect(s.liveRows().length).toBeGreaterThan(0);
    expect(claims).toHaveLength(s.liveRows().length);
    expect(tree).toContain(RECORD_RENDER);
  });
});

describe('12 retires .haive/install.json', () => {
  const git = promisify(execFile);
  const HAIVE_SHAPED = JSON.stringify({
    schemaVersion: 1,
    haiveVersion: '0.1.0',
    templateSetHash: 'abc',
    templates: [],
  });

  const gitOut = async (root: string, ...args: string[]): Promise<string> =>
    (await git('git', ['-C', root, ...args])).stdout;

  /** A repository with one commit, and `.haive/install.json` tracked in it when `installJson` is given. */
  async function seededSetup(installJson?: string) {
    const s = await setup('none');
    await git('git', ['-C', s.root, 'init', '-q', '-b', 'main']);
    await git('git', ['-C', s.root, 'config', 'user.email', 't@example.com']);
    await git('git', ['-C', s.root, 'config', 'user.name', 'T']);
    await git('git', ['-C', s.root, 'config', 'gc.auto', '0']);
    await writeFile(join(s.root, 'README.md'), 'hi\n');
    await git('git', ['-C', s.root, 'add', 'README.md']);
    if (installJson !== undefined) {
      await mkdir(join(s.root, '.haive'), { recursive: true });
      await writeFile(join(s.root, '.haive', 'install.json'), installJson);
      await git('git', ['-C', s.root, 'add', '-f', '.haive/install.json']);
    }
    await git('git', ['-C', s.root, 'commit', '-qm', 'seed']);
    return s;
  }

  const trackedFiles = async (root: string): Promise<string[]> =>
    (await gitOut(root, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').filter(Boolean);

  it('leaves the checkout clean after two identical runs', async () => {
    const s = await seededSetup();

    const first = await recordWritten(s.applyCommit());
    expect(first.commitPerformed).toBe(true);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    const head = await gitOut(s.root, 'rev-parse', 'HEAD');

    const second = await recordWritten(s.applyCommit());

    expect(second.commitPerformed).toBe(false);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    expect(await gitOut(s.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(false);
  });

  it('drops a tracked Haive-shaped file from the commit and the disk', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    expect(await trackedFiles(s.root)).toContain('.haive/install.json');

    const out = await recordWritten(s.applyCommit());

    expect(out.commitPerformed).toBe(true);
    expect(await trackedFiles(s.root)).not.toContain('.haive/install.json');
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(false);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
  });

  it('stages the deletion on a retry that finds the file already gone', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    await rm(join(s.root, '.haive', 'install.json'));

    await recordWritten(s.applyCommit());

    expect(await trackedFiles(s.root)).not.toContain('.haive/install.json');
  });

  it("keeps a file that is not Haive's, and says so", async () => {
    const s = await seededSetup('{"keep":true}');

    const out = await recordWritten(s.applyCommit());

    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(true);
    expect(await trackedFiles(s.root)).toContain('.haive/install.json');
    expect(out.warnings.some((w) => w.startsWith('.haive/install.json was left in place'))).toBe(
      true,
    );
  });

  it('keeps a link standing there and still writes the record', async () => {
    const s = await seededSetup();
    const outside = await mkdtemp(join(tmpdir(), 'post-onboarding-record-out-'));
    dirs.push(outside);
    await writeFile(join(outside, 'elsewhere.json'), HAIVE_SHAPED);
    await mkdir(join(s.root, '.haive'), { recursive: true });
    await symlink(join(outside, 'elsewhere.json'), join(s.root, '.haive', 'install.json'));

    const out = await recordWritten(s.apply());

    expect(out.warnings.some((w) => w.startsWith('.haive/install.json was left in place'))).toBe(
      true,
    );
    expect(existsSync(join(outside, 'elsewhere.json'))).toBe(true);
    expect(existsSync(join(s.root, RECORD_RENDER))).toBe(true);
  });

  it('leaves the file alone when the record write failed', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    let refused = false;
    let domainLocks = 0;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && ++domainLocks > 1 && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await recordWritten(s.apply(), { recordWriteFails: true });

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(true);
  });

  const refuseRecordWrite = (s: Awaited<ReturnType<typeof seededSetup>>) => {
    let refused = false;
    let domainLocks = 0;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && ++domainLocks > 1 && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };
  };

  it('stages the deletion an earlier attempt made when the record write fails', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    await rm(join(s.root, '.haive', 'install.json'));
    refuseRecordWrite(s);

    const out = await recordWritten(s.applyCommit(), { recordWriteFails: true });

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(out.stagedPaths).toContain('.haive/install.json');
    expect(await trackedFiles(s.root)).not.toContain('.haive/install.json');
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
  });

  it('stages no deletion it cannot prove, and says so, when the record write fails', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    const outside = await mkdtemp(join(tmpdir(), 'post-onboarding-record-out-'));
    dirs.push(outside);
    await writeFile(join(outside, 'install.json'), HAIVE_SHAPED);
    await rm(join(s.root, '.haive'), { recursive: true });
    await symlink(outside, join(s.root, '.haive'));
    refuseRecordWrite(s);

    const out = await recordWritten(s.applyCommit(), { recordWriteFails: true });

    expect(out.stagedPaths).not.toContain('.haive/install.json');
    expect(await trackedFiles(s.root)).toContain('.haive/install.json');
    expect(existsSync(join(outside, 'install.json'))).toBe(true);
    expect(
      out.warnings.some((w) =>
        w.startsWith('.haive/install.json was not listed as removed: it could not be checked'),
      ),
    ).toBe(true);
  });

  it('stages no deletion for a manifest still on disk when the record write fails', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    refuseRecordWrite(s);

    const out = await recordWritten(s.applyCommit(), { recordWriteFails: true });

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(out.warnings.filter((w) => w.includes('was not listed as removed'))).toEqual([]);
    expect(out.stagedPaths).not.toContain('.haive/install.json');
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(true);
    expect(await trackedFiles(s.root)).toContain('.haive/install.json');
  });
});

describe('12 retires the legacy environment, exclusions and tooling mirrors', () => {
  const git = promisify(execFile);
  const ENV_UNIT = '.haive-data/state/project/environment.json';
  const GLOBS_UNIT = '.haive-data/state/settings/scope-exclude-globs.json';
  const ENV_LEGACY = '.haive-data/environment.json';
  const GLOBS_LEGACY = '.haive-data/exclusions.json';
  const TOOLING_UNIT = '.haive-data/state/settings/onboarding-tooling.json';
  const TOOLING_LEGACY = '.haive-data/tooling.json';
  const TOOLING_COLUMN = {
    schemaVersion: 1,
    tooling: {
      ragMode: 'internal',
      ollamaUrl: 'http://10.0.0.5:11434',
      ragConnectionString: 'postgres://u:p@h/d',
      importedMcpSettingsJson: '{"mcpServers":{"x":{"command":"evil"}}}',
      importedMcpServerNames: ['x'],
      acceptedMcpSettingsMark: 'mark',
    },
  };
  const HAIVE_TOOLING = JSON.stringify({
    schemaVersion: 1,
    tooling: { ragMode: 'internal' },
  });
  const ENV_COLUMN = {
    schemaVersion: 1,
    envDetectData: { project: { name: 'acme' } },
    confirmedValues: { name: 'acme' },
  };
  const HAIVE_ENV = JSON.stringify(ENV_COLUMN);
  const HAIVE_GLOBS = JSON.stringify({ schemaVersion: 1, scopeExcludeGlobs: ['vendor/**'] });

  const gitOut = async (root: string, ...args: string[]): Promise<string> =>
    (await git('git', ['-C', root, ...args])).stdout;
  const trackedFiles = async (root: string): Promise<string[]> =>
    (await gitOut(root, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').filter(Boolean);

  async function seeded(
    legacy: Record<string, string>,
    columns: Record<string, unknown> = {},
    detect: Record<string, unknown> | null = DETECT,
  ) {
    const s = await setup('none', detect as Record<string, unknown>);
    s.fake.patch(schema.repositories, REPO, {
      onboardingEnvironment: ENV_COLUMN,
      scopeExcludeGlobs: ['vendor/**'],
      ...columns,
    });
    await git('git', ['-C', s.root, 'init', '-q', '-b', 'main']);
    await git('git', ['-C', s.root, 'config', 'user.email', 't@example.com']);
    await git('git', ['-C', s.root, 'config', 'user.name', 'T']);
    await git('git', ['-C', s.root, 'config', 'gc.auto', '0']);
    await writeFile(join(s.root, 'README.md'), 'hi\n');
    await mkdir(join(s.root, '.haive-data'), { recursive: true });
    for (const [rel, content] of Object.entries(legacy)) {
      await writeFile(join(s.root, rel), content);
    }
    await git('git', ['-C', s.root, 'add', '-A']);
    await git('git', ['-C', s.root, 'commit', '-qm', 'seed']);
    return s;
  }

  it('drops tracked Haive-shaped mirrors from the commit and the disk, and leaves the checkout clean', async () => {
    const s = await seeded({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS });
    expect(await trackedFiles(s.root)).toEqual(expect.arrayContaining([ENV_LEGACY, GLOBS_LEGACY]));

    const first = await recordWritten(s.applyCommit());

    expect(first.commitPerformed).toBe(true);
    const files = await trackedFiles(s.root);
    expect(files).toEqual(expect.arrayContaining([ENV_UNIT, GLOBS_UNIT]));
    expect(files).not.toContain(ENV_LEGACY);
    expect(files).not.toContain(GLOBS_LEGACY);
    expect(existsSync(join(s.root, ENV_LEGACY))).toBe(false);
    expect(existsSync(join(s.root, GLOBS_LEGACY))).toBe(false);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    const head = await gitOut(s.root, 'rev-parse', 'HEAD');

    const second = await recordWritten(s.applyCommit());

    expect(second.commitPerformed).toBe(false);
    expect(await gitOut(s.root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('writes neither legacy file where none existed', async () => {
    const s = await seeded({});

    await recordWritten(s.applyCommit());

    expect(existsSync(join(s.root, ENV_LEGACY))).toBe(false);
    expect(existsSync(join(s.root, GLOBS_LEGACY))).toBe(false);
    expect(await trackedFiles(s.root)).toEqual(expect.arrayContaining([ENV_UNIT, GLOBS_UNIT]));
  });

  it("keeps a file at either name that is not Haive's, and says so", async () => {
    const s = await seeded({ [ENV_LEGACY]: '{"keep":true}', [GLOBS_LEGACY]: '{"keep":true}' });

    const out = await recordWritten(s.applyCommit());

    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(true);
      expect(await trackedFiles(s.root), rel).toContain(rel);
      expect(
        out.warnings.some((w) => w.startsWith(`${rel} was left in place`)),
        rel,
      ).toBe(true);
    }
  });

  it('keeps a mirror whose value the record does not carry', async () => {
    const s = await seeded(
      { [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS },
      { onboardingEnvironment: null, scopeExcludeGlobs: null },
    );

    const out = await recordWritten(s.applyCommit());

    expect(existsSync(join(s.root, ENV_UNIT))).toBe(false);
    expect(existsSync(join(s.root, GLOBS_UNIT))).toBe(false);
    for (const rel of [ENV_LEGACY, GLOBS_LEGACY]) {
      expect(existsSync(join(s.root, rel)), rel).toBe(true);
      expect(await trackedFiles(s.root), rel).toContain(rel);
    }
    expect(out.warnings.filter((w) => w.includes('was left in place'))).toEqual([]);
  });

  it('without a render context there is no record: both mirrors are written and committed', async () => {
    const s = await seeded({}, {}, null);

    const out = await s.applyCommit();

    expect(out.recordWrite).toBe('skipped');
    expect(out.commitPerformed).toBe(true);
    expect(existsSync(join(s.root, RECORD_FORMAT))).toBe(false);
    expect(await trackedFiles(s.root)).toEqual(expect.arrayContaining([ENV_LEGACY, GLOBS_LEGACY]));
    expect(JSON.parse(await readFile(join(s.root, ENV_LEGACY), 'utf8'))).toEqual(ENV_COLUMN);
    expect(JSON.parse(await readFile(join(s.root, GLOBS_LEGACY), 'utf8'))).toEqual({
      schemaVersion: 1,
      scopeExcludeGlobs: ['vendor/**'],
    });
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
  });

  it('leaves the mirrors alone when the record write failed', async () => {
    const s = await seeded({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: HAIVE_GLOBS });
    let refused = false;
    let domainLocks = 0;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && ++domainLocks > 1 && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await recordWritten(s.apply(), { recordWriteFails: true });

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(existsSync(join(s.root, ENV_LEGACY))).toBe(true);
    expect(existsSync(join(s.root, GLOBS_LEGACY))).toBe(true);
  });

  it('writes both mirrors again, and commits them, when the record write failed', async () => {
    const stale = JSON.stringify({ schemaVersion: 1, scopeExcludeGlobs: ['stale/**'] });
    const s = await seeded({ [ENV_LEGACY]: HAIVE_ENV, [GLOBS_LEGACY]: stale });
    let refused = false;
    let domainLocks = 0;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && ++domainLocks > 1 && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await recordWritten(s.applyCommit(), { recordWriteFails: true });

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(out.commitPerformed).toBe(true);
    expect(await trackedFiles(s.root)).toEqual(expect.arrayContaining([ENV_LEGACY, GLOBS_LEGACY]));
    expect(JSON.parse(await readFile(join(s.root, GLOBS_LEGACY), 'utf8'))).toEqual({
      schemaVersion: 1,
      scopeExcludeGlobs: ['vendor/**'],
    });
  });

  it('drops a tracked Haive-shaped tooling.json and commits the unit without a machine-local key', async () => {
    const s = await seeded(
      { [TOOLING_LEGACY]: HAIVE_TOOLING },
      { onboardingTooling: TOOLING_COLUMN },
    );
    expect(await trackedFiles(s.root)).toContain(TOOLING_LEGACY);

    const first = await recordWritten(s.applyCommit());

    expect(first.commitPerformed).toBe(true);
    const files = await trackedFiles(s.root);
    expect(files).toContain(TOOLING_UNIT);
    expect(files).not.toContain(TOOLING_LEGACY);
    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(false);
    expect(JSON.parse(await readFile(join(s.root, TOOLING_UNIT), 'utf8'))).toEqual({
      ragMode: 'internal',
      mcpSettingsJson: '{"mcpServers":{"x":{"command":"evil"}}}',
    });
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    const head = await gitOut(s.root, 'rev-parse', 'HEAD');

    const second = await recordWritten(s.applyCommit());

    expect(second.commitPerformed).toBe(false);
    expect(await gitOut(s.root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('writes no tooling.json where none existed', async () => {
    const s = await seeded({}, { onboardingTooling: TOOLING_COLUMN });

    await recordWritten(s.applyCommit());

    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(false);
    expect(await trackedFiles(s.root)).toContain(TOOLING_UNIT);
  });

  it("keeps a tooling.json that is not Haive's, and says so", async () => {
    const s = await seeded(
      { [TOOLING_LEGACY]: '{"keep":true}' },
      { onboardingTooling: TOOLING_COLUMN },
    );

    const out = await recordWritten(s.applyCommit());

    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(true);
    expect(await trackedFiles(s.root)).toContain(TOOLING_LEGACY);
    expect(out.warnings.some((w) => w.startsWith(`${TOOLING_LEGACY} was left in place`))).toBe(
      true,
    );
  });

  it('keeps tooling.json when the record does not carry the tooling', async () => {
    const s = await seeded({ [TOOLING_LEGACY]: HAIVE_TOOLING }, { onboardingTooling: null });

    const out = await recordWritten(s.applyCommit());

    expect(existsSync(join(s.root, TOOLING_UNIT))).toBe(false);
    expect(existsSync(join(s.root, TOOLING_LEGACY))).toBe(true);
    expect(out.warnings.filter((w) => w.includes('was left in place'))).toEqual([]);
  });

  it('without a render context there is no record: tooling.json is written, stripped, and committed', async () => {
    const s = await seeded({}, { onboardingTooling: TOOLING_COLUMN }, null);

    const out = await s.applyCommit();

    expect(out.recordWrite).toBe('skipped');
    expect(out.commitPerformed).toBe(true);
    expect(existsSync(join(s.root, TOOLING_UNIT))).toBe(false);
    expect(await trackedFiles(s.root)).toContain(TOOLING_LEGACY);
    expect(JSON.parse(await readFile(join(s.root, TOOLING_LEGACY), 'utf8'))).toEqual({
      schemaVersion: 1,
      tooling: { ragMode: 'internal' },
    });
  });

  it('writes tooling.json again, and commits it, when the record write failed', async () => {
    const s = await seeded(
      { [TOOLING_LEGACY]: HAIVE_TOOLING },
      { onboardingTooling: TOOLING_COLUMN },
    );
    let refused = false;
    let domainLocks = 0;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && ++domainLocks > 1 && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await recordWritten(s.applyCommit(), { recordWriteFails: true });

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(await trackedFiles(s.root)).toContain(TOOLING_LEGACY);
    expect(JSON.parse(await readFile(join(s.root, TOOLING_LEGACY), 'utf8'))).toEqual({
      schemaVersion: 1,
      tooling: { ragMode: 'internal' },
    });
  });

  it.each([
    ['another schema version', { ...TOOLING_COLUMN, schemaVersion: 2 }],
    [
      'a unit past the file limit',
      {
        schemaVersion: 1,
        tooling: { ragMode: 'internal', pad: 'x'.repeat(1024 * 1024) },
      },
    ],
  ])(
    'with %s the record carries no tooling unit: tooling.json is written, committed, and not retired',
    async (_why, column) => {
      const stale = JSON.stringify({ schemaVersion: 1, tooling: { ragMode: 'stale' } });
      const s = await seeded({ [TOOLING_LEGACY]: stale }, { onboardingTooling: column });

      const out = await recordWritten(s.applyCommit());

      expect(out.commitPerformed).toBe(true);
      expect(existsSync(join(s.root, TOOLING_UNIT))).toBe(false);
      expect(existsSync(join(s.root, RECORD_FORMAT))).toBe(true);
      expect(await trackedFiles(s.root)).toContain(TOOLING_LEGACY);
      const written = JSON.parse(await readFile(join(s.root, TOOLING_LEGACY), 'utf8')) as {
        schemaVersion: number;
        tooling: Record<string, unknown>;
      };
      expect(written.schemaVersion).toBe(column.schemaVersion);
      expect(written.tooling.ragMode).toBe('internal');
      expect(written.tooling.ollamaUrl).toBeUndefined();
      expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    },
  );
});

it('records bundled skills only at catalog destinations from the stored generation', async () => {
  const s = await setup('none');
  const bundleId = '00000000-0000-4000-8000-0000000000e2';
  s.fake.insert(schema.customBundles, {
    id: bundleId,
    userId: USER,
    repositoryId: REPO,
    name: 'skills',
    sourceType: 'zip',
    storageRoot: '/bundles/skills',
  });
  s.fake.insert(schema.customBundleItems, {
    bundleId,
    kind: 'skill',
    sourceFormat: 'skill-md',
    sourcePath: 'skills/kept/SKILL.md',
    normalizedSpec: {
      id: 'kept',
      title: 'Kept',
      description: 'A skill',
      overview: 'Overview',
      subSkills: [],
    },
    contentHash: 'c'.repeat(64),
    schemaVersion: 1,
  });
  s.fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '09_5-skill-generation',
    round: 0,
    detectOutput: { skillTargetDirs: ['', '.', 'other/skills', '.claude/skills'] },
  });
  await recordWritten(s.apply());
  const skillPaths = s.fake
    .rows(schema.onboardingArtifacts)
    .filter((r) => r.templateKind === 'custom-skill')
    .map((r) => r.diskPath);
  expect(skillPaths).toEqual(['.claude/skills/kept/SKILL.md']);
});
