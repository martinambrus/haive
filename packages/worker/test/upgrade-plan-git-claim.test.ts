import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  PROVIDERS,
  REPO,
  USER,
  ONBOARDING,
  ctxFor,
  newDb,
  seedProviders,
  seedRepository,
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
  it.each(['.git/config', 'sub/.GIT/config'])(
    'neither lists %s nor reads its bytes into the plan',
    async (diskPath) => {
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
