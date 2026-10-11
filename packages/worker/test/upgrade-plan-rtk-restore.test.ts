import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  PROVIDERS,
  REPO,
  RTK_BLOCK,
  TASK,
  USER,
  ctxFor,
  newDb,
  seedProviders,
  seedRepository,
  type Fake,
} from './support/upgrade-plan-fixtures.js';

const COLUMN = {
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  rtkEnabled: true,
  rtkChoiceRecorded: true,
};
const AGENTS_LEFT = '# rules\n';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'upgrade-plan-rtk-restore-'));
  await writeFile(join(repo, 'AGENTS.md'), AGENTS_LEFT, 'utf8');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function record(fake: Fake, kind: string, file: string, at: number) {
  fake.insert(schema.onboardingArtifacts, {
    userId: USER,
    repositoryId: REPO,
    taskId: TASK,
    diskPath: file,
    templateId: kind,
    templateKind: kind,
    templateSchemaVersion: 1,
    templateContentHash: 'h',
    writtenHash: 'h',
    writtenContent: AGENTS_LEFT,
    lastObservedDiskHash: 'l',
    userModified: false,
    formValuesSnapshot: null,
    sourceStepId: '02-upgrade-apply',
    source: 'backfill',
    haiveVersion: null,
    generatedAt: new Date(at),
    supersededAt: new Date(at),
    bundleItemId: null,
  });
}

async function offered(
  opts: {
    live?: boolean;
    column?: Record<string, unknown>;
    seed?: (fake: Fake) => void;
  } = {},
) {
  const fake = newDb();
  seedProviders(fake, PROVIDERS);
  seedRepository(fake, {
    source: 'git_https',
    rtkEnabled: opts.live ?? true,
    renderContext: { ...COLUMN, ...opts.column },
  });
  (opts.seed ?? ((f) => record(f, 'rtk-block', 'AGENTS.md', 1000)))(fake);
  const detected = await upgradePlanStep.detect!(ctxFor(fake, repo));
  return (detected as unknown as { rtkBlockRestorable?: string[] }).rtkBlockRestorable;
}

describe('01 offers the RTK block back', () => {
  it('(a) offers AGENTS.md when a strip record exists, RTK is on and the file holds no block', async () => {
    expect(await offered()).toEqual(['AGENTS.md']);
  });

  it('(b) offers nothing without a strip record', async () => {
    expect(await offered({ seed: () => undefined })).toEqual([]);
  });

  it('(b) offers nothing for a strip record of CLAUDE.md alone', async () => {
    expect(await offered({ seed: (f) => record(f, 'rtk-block', 'CLAUDE.md', 1000) })).toEqual([]);
  });

  it('(b) offers nothing while a block stands', async () => {
    await writeFile(join(repo, 'AGENTS.md'), `${AGENTS_LEFT}${RTK_BLOCK}`, 'utf8');
    expect(await offered()).toEqual([]);
  });

  it('(b) offers nothing while RTK is off', async () => {
    expect(await offered({ live: false })).toEqual([]);
  });

  it('(b) offers nothing for a context that recorded no RTK choice', async () => {
    expect(await offered({ column: { rtkChoiceRecorded: false } })).toEqual([]);
  });

  it('(b) offers nothing with no enabled provider', async () => {
    expect(await offered({ column: { enabledCliProviders: [] } })).toEqual([]);
  });

  it('(b) offers nothing when a restore record is newer than the strip', async () => {
    expect(
      await offered({
        seed: (f) => {
          record(f, 'rtk-block', 'AGENTS.md', 1000);
          record(f, 'rtk-block-restore', 'AGENTS.md', 2000);
        },
      }),
    ).toEqual([]);
  });

  // A re-onboarding writes the block without a record, so a strip from before the reset proves nothing.
  it('(b) offers nothing for a strip recorded before the last onboarding reset', async () => {
    expect(
      await offered({
        seed: (f) => {
          record(f, 'rtk-block', 'AGENTS.md', 1000);
          f.patch(schema.repositories, REPO, { onboardingResetAt: new Date(2000) });
        },
      }),
    ).toEqual([]);
  });

  it('(b) still offers a strip recorded after the last onboarding reset', async () => {
    expect(
      await offered({
        seed: (f) => {
          f.patch(schema.repositories, REPO, { onboardingResetAt: new Date(500) });
          record(f, 'rtk-block', 'AGENTS.md', 1000);
        },
      }),
    ).toEqual(['AGENTS.md']);
  });

  it('(b) offers again when a strip record is newer than the restore', async () => {
    expect(
      await offered({
        seed: (f) => {
          record(f, 'rtk-block', 'AGENTS.md', 1000);
          record(f, 'rtk-block-restore', 'AGENTS.md', 2000);
          record(f, 'rtk-block', 'AGENTS.md', 3000);
        },
      }),
    ).toEqual(['AGENTS.md']);
  });

  it('(b) offers nothing for a link or a file that is not UTF-8', async () => {
    await rm(join(repo, 'AGENTS.md'));
    await mkdir(join(repo, 'docs'));
    await writeFile(join(repo, 'docs', 'rules.md'), AGENTS_LEFT, 'utf8');
    await symlink('docs/rules.md', join(repo, 'AGENTS.md'));
    expect(await offered()).toEqual([]);
    await rm(join(repo, 'AGENTS.md'));
    await writeFile(join(repo, 'AGENTS.md'), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
    expect(await offered()).toEqual([]);
  });
});
