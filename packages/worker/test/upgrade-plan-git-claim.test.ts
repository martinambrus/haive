import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { namesGitData } from '@haive/shared/project-state';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  expandManifestFor,
  type TemplateRenderContext,
} from '../src/step-engine/template-manifest.js';
import {
  PROVIDERS,
  REPO,
  USER,
  ONBOARDING,
  ctxFor,
  newDb,
  seedProviders,
  seedRepository,
  type LoggerCalls,
} from './support/upgrade-plan-fixtures.js';

const COLUMN = {
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  rtkEnabled: false,
  rtkChoiceRecorded: true,
};
const GIT_CONFIG = '[remote "origin"]\n\turl = https://secret-token@example.com/acme.git\n';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'upgrade-plan-git-claim-'));
  await mkdir(join(repo, '.git'));
  await writeFile(join(repo, '.git', 'config'), GIT_CONFIG, 'utf8');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('01 and a ledger row that names a path in git data', () => {
  it.each(['.git/config', 'sub/.GIT/config', '.git./config'])(
    'neither lists %s nor reads its bytes into the plan',
    async (diskPath) => {
      await mkdir(dirname(join(repo, diskPath)), { recursive: true });
      await writeFile(join(repo, diskPath), GIT_CONFIG, 'utf8');
      const fake = newDb();
      seedProviders(fake, PROVIDERS);
      seedRepository(fake, { source: 'git_https', rtkEnabled: false, renderContext: COLUMN });
      fake.insert(schema.onboardingArtifacts, {
        userId: USER,
        repositoryId: REPO,
        taskId: ONBOARDING,
        diskPath,
        templateId: 'plugin.unknown',
        templateKind: 'plugin-file',
        templateSchemaVersion: 1,
        templateContentHash: 'h',
        writtenHash: 'w',
        userModified: false,
        formValuesSnapshot: null,
        sourceStepId: 'project-state-import',
        source: 'backfill',
        haiveVersion: null,
        generatedAt: new Date(1000),
        supersededAt: null,
        bundleItemId: null,
      });
      const detected = (await upgradePlanStep.detect!(ctxFor(fake, repo))) as unknown as {
        entries: Array<{ diskPath: string }>;
      };
      expect(detected.entries.map((e) => e.diskPath)).not.toContain(diskPath);
      expect(JSON.stringify(detected)).not.toContain('secret-token');
    },
  );
});

describe('01 backfills no row at a path that names git data', () => {
  it('records no row at a git-data agent target of a column that names no CLIs, says so, and still records the ordinary one', async () => {
    const { enabledCliProviders: _membership, ...unnamed } = COLUMN;
    const column = {
      ...unnamed,
      agentTargets: [
        { dir: '.git/hooks', format: 'markdown', supportsLsp: false },
        ...COLUMN.agentTargets,
      ],
    };
    const rendered = { ...column, enabledCliProviders: [] } as unknown as TemplateRenderContext;
    for (const r of expandManifestFor(rendered)) {
      if (r.templateId !== 'agent.code-reviewer') continue;
      await mkdir(dirname(join(repo, r.diskPath)), { recursive: true });
      await writeFile(join(repo, r.diskPath), r.content, 'utf8');
    }
    const fake = newDb();
    seedProviders(fake, PROVIDERS);
    seedRepository(fake, { source: 'git_https', rtkEnabled: false, renderContext: column });
    const logs: LoggerCalls = { calls: [] };
    const ctx = ctxFor(fake, repo, logs);

    const detected = await upgradePlanStep.detect!(ctx);
    expect(detected.ranBackfill).toBe(true);
    expect(detected.renderCtxSnapshot.agentTargets).toContainEqual(
      expect.objectContaining({ dir: '.git/hooks' }),
    );
    const out = await upgradePlanStep.apply(ctx, {
      detected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });

    const paths = fake.rows(schema.onboardingArtifacts).map((r) => r.diskPath as string);
    expect(paths.filter(namesGitData)).toEqual([]);
    expect(paths).toContain('.claude/agents/code-reviewer.md');
    expect(out.backfilledRows).toBe(paths.length);
    expect(logs.calls.filter((c) => c.level === 'warn').map((c) => c.args[0])).toContainEqual(
      expect.objectContaining({ diskPath: '.git/hooks/code-reviewer.md' }),
    );
  });
});
