import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  buildClaudeSettingsJson,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  logger,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { readUpgradeFile } from '@haive/shared/rules-files';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  readDiskContent,
  UNREAD_HASH,
  type UpgradePlanEntry,
  type UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  removeIfHaives,
  upgradeApplyStep,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { generateFilesStep } from '../src/step-engine/steps/onboarding/07-generate-files.js';
import type { GenerateFilesDetect } from '../src/step-engine/steps/onboarding/07-generate-files.js';
import { applyKbWrites } from '../src/step-engine/steps/onboarding/_kb-write.js';
import { restoreRulesImportStubs } from '../src/step-engine/steps/onboarding/_rules-files.js';
import { ensureGitExcludeEntry } from '../src/repo/git-init.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const PRIOR_TASK = '00000000-0000-4000-8000-0000000000c2';

const OLD_REGION = `${CLI_RULES_START}\nOLD RULES\n${CLI_RULES_END}`;
const NEW_REGION = `${CLI_RULES_START}\nNEW RULES\n${CLI_RULES_END}`;
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

/** Latin-1 "é" (0xe9) outside any region: not UTF-8, and decoded leniently it becomes U+FFFD. */
const badBytes = (tail: string) =>
  Buffer.concat([Buffer.from('# Caf'), Buffer.from([0xe9]), Buffer.from(`\n\n${tail}`)]);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, Buffer | string>) {
  const root = await mkdtemp(join(tmpdir(), 'non-utf8-rules-'));
  dirs.push(root);
  for (const [rel, data] of Object.entries(files)) {
    const at = join(root, rel);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, data);
  }
  return root;
}

const sameBytes = async (root: string, rel: string, bytes: Buffer) =>
  (await readFile(join(root, rel))).equals(bytes);

const noop = () => undefined;
const quietLogger = { info: noop, warn: noop, error: noop, debug: noop };

describe('readUpgradeFile', () => {
  it('reads a file that is not UTF-8 as unread, never as a mangled text', async () => {
    const root = await repo({ 'AGENTS.md': badBytes('x\n') });
    expect(await readUpgradeFile(root, 'AGENTS.md')).toEqual({
      kind: 'unread',
      reason: 'undecodable',
    });
  });
});

describe('01 and a file that is not UTF-8', () => {
  it('plans it as a path it did not read, with no content', async () => {
    const root = await repo({ '.claude/settings.json': badBytes('{}') });
    expect(await readDiskContent(root, '.claude/settings.json')).toEqual({
      content: null,
      hash: UNREAD_HASH,
      unread: 'undecodable',
    });
  });
});

describe('02 and a rules file that is not UTF-8', () => {
  function entry(partial: Partial<UpgradePlanEntry>) {
    return {
      entryId: 'e:AGENTS.md',
      bucket: 'new_artifact',
      templateId: 'cli-rules',
      templateKind: CLI_RULES_TEMPLATE_KIND,
      diskPath: 'AGENTS.md',
      liveArtifactId: null,
      currentContent: null,
      newContent: NEW_REGION,
      baselineContent: null,
      currentHash: null,
      baselineWrittenHash: null,
      newContentHash: hashOf(NEW_REGION),
      baselineTemplateContentHash: null,
      currentTemplateContentHash: hashOf(NEW_REGION),
      templateSchemaVersion: 2,
      delta: null,
      ...partial,
    } satisfies UpgradePlanEntry;
  }

  async function apply(
    root: string,
    entries: UpgradePlanEntry[] = [entry({})],
    formValues: Record<string, unknown> = { selectedNew: ['e:AGENTS.md'] },
  ) {
    const fake = createFakeDb({
      onboardingArtifacts: schema.onboardingArtifacts,
      repositories: schema.repositories,
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
      cliProviders: schema.cliProviders,
      projectStateSync: schema.projectStateSync,
    });
    fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
    const plan = {
      repositoryId: REPO,
      ranBackfill: false,
      entries,
      counts: {
        unchanged: 0,
        clean_update: 0,
        adopt: 0,
        conflict: 0,
        new_artifact: 1,
        user_deleted: 0,
        obsolete: 0,
      },
      installedTemplateSetHash: null,
      currentTemplateSetHash: 'set',
      renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
      backfilledRows: 0,
    } as UpgradePlanOutput;
    const ctx = {
      db: fake.db,
      repoPath: root,
      taskId: TASK,
      userId: USER,
      logger: quietLogger,
    } as unknown as StepContext;
    return upgradeApplyStep.apply(ctx, {
      detected: plan,
      formValues,
      iteration: 0,
      previousIterations: [],
    });
  }

  it('keeps every byte of an AGENTS.md it would write the rules region into, and says why', async () => {
    const bytes = badBytes('notes\n');
    const root = await repo({ 'AGENTS.md': bytes });
    const out = await apply(root);
    expect(await sameBytes(root, 'AGENTS.md', bytes)).toBe(true);
    expect(out.warnings.some((w) => w.includes('AGENTS.md') && /UTF-8/.test(w))).toBe(true);
  });

  it('keeps a settings file holding the RTK hook and a byte that is not UTF-8, and says why', async () => {
    const rel = '.claude/settings.json';
    const hook = JSON.parse(buildClaudeSettingsJson()) as Record<string, unknown>;
    hook.theme = 'café';
    const bytes = Buffer.from(`${JSON.stringify(hook, null, 2)}\n`, 'latin1');
    const root = await repo({ [rel]: bytes });
    const lenient = bytes.toString('utf8');
    const out = await apply(
      root,
      [
        entry({
          entryId: `e:${rel}`,
          bucket: 'obsolete',
          templateId: 'rtk.claude-settings',
          templateKind: 'rtk-config',
          diskPath: rel,
          currentContent: lenient,
          currentHash: hashOf(lenient),
          newContent: null,
          newContentHash: null,
        }),
      ],
      { selectedRtkHookStrips: [`e:${rel}`] },
    );
    expect(await sameBytes(root, rel, bytes)).toBe(true);
    expect(out.warnings.some((w) => w.includes(rel) && /UTF-8/.test(w))).toBe(true);
  });

  it('keeps every byte of an AGENTS.md whose region it would remove', async () => {
    const bytes = badBytes(`${OLD_REGION}\n`);
    const root = await repo({ 'AGENTS.md': bytes });
    const removal = await removeIfHaives(
      root,
      'AGENTS.md',
      { diskPath: 'AGENTS.md', templateKind: CLI_RULES_TEMPLATE_KIND },
      hashOf(OLD_REGION),
    );
    expect(await sameBytes(root, 'AGENTS.md', bytes)).toBe(true);
    expect(removal).toMatchObject({ outcome: 'kept' });
    expect(removal.outcome === 'kept' && removal.refusal).toMatch(/UTF-8/);
  });
});

describe('04 and a rules file that is not UTF-8', () => {
  const PRIOR_REGION = `${CLI_RULES_START}\nPRIOR RULES\n${CLI_RULES_END}`;

  async function rollback(root: string, left: string, removed: boolean) {
    const fake = createFakeDb({
      onboardingArtifacts: schema.onboardingArtifacts,
      repositories: schema.repositories,
    });
    const prior = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: PRIOR_TASK,
      diskPath: 'AGENTS.md',
      templateId: 'cli-rules',
      templateKind: CLI_RULES_TEMPLATE_KIND,
      templateSchemaVersion: 1,
      templateContentHash: hashOf(PRIOR_REGION),
      writtenHash: hashOf(PRIOR_REGION),
      writtenContent: PRIOR_REGION,
      source: removed ? 'backfill' : 'onboarding',
      supersededAt: new Date(),
    });
    const upgrade = removed
      ? null
      : fake.insert(schema.onboardingArtifacts, {
          userId: USER,
          repositoryId: REPO,
          taskId: PRIOR_TASK,
          diskPath: 'AGENTS.md',
          templateId: 'cli-rules',
          templateKind: CLI_RULES_TEMPLATE_KIND,
          templateSchemaVersion: 1,
          templateContentHash: hashOf(left),
          writtenHash: hashOf(left),
          lastObservedDiskHash: hashOf(left),
          writtenContent: left,
          source: 'upgrade',
        });
    const ctx = {
      db: fake.db,
      repoPath: root,
      taskId: TASK,
      userId: USER,
      logger: quietLogger,
    } as unknown as StepContext;
    const detected = {
      repositoryId: REPO,
      rolledBackFromTaskId: PRIOR_TASK,
      targets: [
        {
          diskPath: 'AGENTS.md',
          templateId: 'cli-rules',
          templateKind: CLI_RULES_TEMPLATE_KIND,
          templateSchemaVersion: 1,
          priorArtifactId: prior.id as string,
          upgradeArtifactId: upgrade ? (upgrade.id as string) : null,
          ...(removed ? { removed: true } : {}),
          priorTemplateContentHash: hashOf(PRIOR_REGION),
          priorWrittenHash: hashOf(PRIOR_REGION),
          priorWrittenContent: PRIOR_REGION,
          priorFormValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
        },
      ],
      newArtifactsToUndo: [],
      warnings: [],
    };
    return upgradeRollbackStep.apply(ctx, { detected } as never);
  }

  it('keeps every byte of an AGENTS.md whose region it would put back over the upgrade', async () => {
    const bytes = badBytes(`${NEW_REGION}\n`);
    const root = await repo({ 'AGENTS.md': bytes });
    const out = await rollback(root, NEW_REGION, false);
    expect(await sameBytes(root, 'AGENTS.md', bytes)).toBe(true);
    expect(out.revertedCount).toBe(0);
    expect(out.warnings.some((w) => /UTF-8/.test(w))).toBe(true);
  });

  it('keeps every byte of an AGENTS.md it would put a removed region back into', async () => {
    const bytes = badBytes('notes\n');
    const root = await repo({ 'AGENTS.md': bytes });
    const out = await rollback(root, NEW_REGION, true);
    expect(await sameBytes(root, 'AGENTS.md', bytes)).toBe(true);
    expect(out.revertedCount).toBe(0);
    expect(out.warnings.some((w) => /UTF-8/.test(w))).toBe(true);
  });
});

describe('the callers of updateFileNoFollow and a file that is not UTF-8', () => {
  it('ensureRulesImportStub: restoreRulesImportStubs refuses the stub and keeps its bytes', async () => {
    const bytes = badBytes('no import line here\n');
    const root = await repo({ 'CLAUDE.md': bytes });
    const [outcome] = await restoreRulesImportStubs(root, ['CLAUDE.md']);
    expect(await sameBytes(root, 'CLAUDE.md', bytes)).toBe(true);
    expect(outcome).toMatchObject({ file: 'CLAUDE.md', result: 'refused' });
    expect(outcome!.error).toMatch(/UTF-8/);
  });

  it('07: an AGENTS.md it would append to is kept byte for byte, and the file is reported skipped', async () => {
    const bytes = badBytes('notes\n');
    const root = await repo({ 'AGENTS.md': bytes });
    const detected: GenerateFilesDetect = {
      framework: null,
      language: null,
      projectName: 'demo',
      projectInfo: {
        name: 'demo',
        framework: null,
        primaryLanguage: null,
        description: null,
        localUrl: null,
        databaseType: null,
        databaseVersion: null,
        webserver: null,
        docroot: null,
        runtimeVersions: {},
        testFrameworks: [],
        testPaths: [],
        buildTool: null,
        commands: [],
        containerType: null,
      },
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
      mcpSettingsJson: '',
      cliProviders: [{ name: 'claude-code', rulesContent: '- rule one' }],
      agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
      plannedAgents: [],
      existingFiles: [],
      unmanagedAgentFiles: [],
      rtkEnabled: false,
      enabledCliProviders: [],
    };
    const out = await generateFilesStep.apply(
      {
        taskId: 't1',
        taskStepId: 'ts1',
        userId: 'u1',
        repoPath: root,
        workspacePath: root,
        cliProviderId: null,
        logger: logger.child({ test: 'non-utf8-rules' }),
        emitProgress: async () => {},
      } as unknown as StepContext,
      { iteration: 0, previousIterations: [], detected, formValues: {} },
    );
    expect(await sameBytes(root, 'AGENTS.md', bytes)).toBe(true);
    expect(out.skippedFiles).toContain('AGENTS.md');
    expect(out.wroteFiles).not.toContain('AGENTS.md');
  });

  it('_kb-write: a KB file it would append to is kept and the write is skipped', async () => {
    const bytes = badBytes('body\n');
    const rel = '.haive-data/knowledge_base/NOTES.md';
    const root = await repo({ [rel]: bytes });
    const out = await applyKbWrites(
      root,
      [{ relPath: 'NOTES.md', section: 'S', content: 'new' }] as never,
      '2026-01-01T00:00:00.000Z',
    );
    expect(await sameBytes(root, rel, bytes)).toBe(true);
    expect(out.written).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.reason).toMatch(/UTF-8/);
  });

  it('git-init: .git/info/exclude is refused and kept', async () => {
    const bytes = Buffer.concat([Buffer.from('# '), Buffer.from([0xe9]), Buffer.from('\n')]);
    const root = await repo({ '.git/info/exclude': bytes });
    await expect(ensureGitExcludeEntry(root)).rejects.toThrow(/UTF-8/);
    expect(await sameBytes(root, '.git/info/exclude', bytes)).toBe(true);
  });
});
