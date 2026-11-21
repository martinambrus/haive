import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  AGENT_RENDERER_VERSION,
  bundleAgentTemplateHash,
  normalizeContent,
  sha256Hex,
  type AgentSpec,
  type SkillEntry,
} from '@haive/shared';
import { getTemplateManifest } from '../src/step-engine/template-manifest.js';
import {
  BASELINE_AGENT_SPECS,
  buildAgentFileForTarget,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';
import {
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { RECORD_WRITE_TABLES, recordWritten } from './support/upgrade-apply-record.js';
import {
  ONBOARDING,
  REPO,
  USER,
  ctxFor,
  seedProviders,
  seedRepository,
  type Fake,
} from './support/upgrade-plan-fixtures.js';

// A renderer-version bump reaches installed custom-bundle agents and built-in agents, and leaves skills alone.

const TARGET = { dir: '.claude/agents', format: 'markdown' as const, supportsLsp: true };
const CLAUDE_IMPORT = { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' };
const column = (cliTargets: string[]) => ({
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web' },
  framework: 'drupal',
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
  cliTargets,
  agentTargets: [],
  enabledCliProviders: cliTargets.map(() => CLAUDE_IMPORT),
  rtkEnabled: true,
  rtkChoiceRecorded: true,
});

const OLD_VERSION = AGENT_RENDERER_VERSION - 1;
const salted = (ir: string, version: number) => sha256Hex(`${ir}\nhaive-agent-renderer:${version}`);
const hashOf = (text: string) => sha256Hex(normalizeContent(text));
const OLD_BYTES = 'BODY FROM AN OLDER RENDERER\n';
const IR = 'c'.repeat(64);

const AGENT: AgentSpec = {
  id: 'billing-expert',
  title: 'Billing Expert',
  description: 'knows the billing module',
  color: 'blue',
  field: 'billing',
  tools: ['Read'],
  coreMission: 'Answer billing questions.',
  responsibilities: ['Explain invoices'],
  whenInvoked: ['A billing question comes up'],
  executionSteps: [{ title: 'Look', body: 'Read the module.' }],
  outputFormat: 'Plain answer.',
  qualityCriteria: ['Correct'],
  antiPatterns: ['Guess'],
};
const SKILL: SkillEntry = {
  id: 'styling',
  title: 'Styling',
  description: 'how to style',
  overview: 'style guide',
  subSkills: [],
};

it('reproduces the shared salt format', () => {
  expect(salted(IR, AGENT_RENDERER_VERSION)).toBe(bundleAgentTemplateHash(IR));
});

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'upgrade-renderer-bump-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function world(cliTargets: string[] = ['claude-code']) {
  const fake = createFakeDb({
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    ...RECORD_WRITE_TABLES,
  }) as unknown as Fake;
  seedProviders(fake, [{ name: 'claude-code', enabled: true }]);
  seedRepository(fake, {
    source: 'git_https',
    rtkEnabled: true,
    renderContext: column(cliTargets),
  });
  const ctx = ctxFor(fake, repo);
  const bundleId = randomUUID();
  fake.insert(schema.customBundles, {
    id: bundleId,
    userId: USER,
    repositoryId: REPO,
    name: 'acme-kit',
    sourceType: 'zip',
    storageRoot: '/bundles/acme-kit',
  });
  const addItem = (kind: 'agent' | 'skill', spec: object): string => {
    const id = randomUUID();
    fake.insert(schema.customBundleItems, {
      id,
      bundleId,
      kind,
      sourceFormat: kind === 'agent' ? 'claude-md' : 'skill-md',
      sourcePath: `${kind}s/${id}.md`,
      normalizedSpec: spec as Record<string, unknown>,
      contentHash: IR,
      schemaVersion: 1,
    });
    return id;
  };
  const record = (args: {
    diskPath: string;
    templateId: string;
    templateKind: string;
    schemaVersion: number;
    contentHash: string;
    bytes: string;
    bundleItemId?: string;
  }) =>
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: ONBOARDING,
      diskPath: args.diskPath,
      templateId: args.templateId,
      templateKind: args.templateKind,
      templateSchemaVersion: args.schemaVersion,
      templateContentHash: args.contentHash,
      writtenHash: hashOf(args.bytes),
      writtenContent: args.bytes,
      lastObservedDiskHash: hashOf(args.bytes),
      userModified: false,
      formValuesSnapshot: null,
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      haiveVersion: null,
      generatedAt: new Date(1000),
      supersededAt: null,
      bundleItemId: args.bundleItemId ?? null,
    }).id as string;
  const put = async (diskPath: string, bytes: string) => {
    await mkdir(join(repo, diskPath, '..'), { recursive: true });
    await writeFile(join(repo, diskPath), bytes, 'utf8');
  };
  const detect = () => upgradePlanStep.detect!(ctx);
  const entryFor = (d: UpgradePlanDetect, templateId: string, diskPath?: string) =>
    d.entries.filter(
      (e) => e.templateId === templateId && (diskPath === undefined || e.diskPath === diskPath),
    );
  return { fake, ctx, bundleId, addItem, record, put, detect, entryFor };
}

/** A custom-bundle agent installed at `version`, its file holding the bytes an older renderer wrote. */
async function installedBundleAgent(w: ReturnType<typeof world>, version: number) {
  const itemId = w.addItem('agent', AGENT);
  const templateId = `custom.${w.bundleId}.${itemId}`;
  const diskPath = '.claude/agents/billing-expert.md';
  await w.put(diskPath, OLD_BYTES);
  const rowId = w.record({
    diskPath,
    templateId,
    templateKind: 'custom-agent',
    schemaVersion: 1,
    contentHash: salted(IR, version),
    bytes: OLD_BYTES,
    bundleItemId: itemId,
  });
  return { itemId, templateId, diskPath, rowId };
}

describe('a renderer-version bump reaches installed custom-bundle agents', () => {
  it('plans a bundle agent recorded at the previous version as a clean update to the current body', async () => {
    const w = world();
    const a = await installedBundleAgent(w, OLD_VERSION);
    const [entry] = w.entryFor(await w.detect(), a.templateId, a.diskPath);

    expect(entry?.bucket).toBe('clean_update');
    expect(entry?.newContent).toBe(buildAgentFileForTarget(AGENT, TARGET));
  });

  it('plans a bundle agent whose file already holds the current body as an adopt', async () => {
    const w = world();
    const a = await installedBundleAgent(w, OLD_VERSION);
    await w.put(a.diskPath, buildAgentFileForTarget(AGENT, TARGET));
    const [entry] = w.entryFor(await w.detect(), a.templateId, a.diskPath);

    expect(entry?.bucket).toBe('adopt');
  });

  it('plans a bundle agent whose file was edited as a conflict', async () => {
    const w = world();
    const a = await installedBundleAgent(w, OLD_VERSION);
    await w.put(a.diskPath, 'EDITED BY A PERSON\n');
    const [entry] = w.entryFor(await w.detect(), a.templateId, a.diskPath);

    expect(entry?.bucket).toBe('conflict');
  });

  it('plans a bundle agent recorded at the current version as unchanged', async () => {
    const w = world();
    const a = await installedBundleAgent(w, AGENT_RENDERER_VERSION);
    const [entry] = w.entryFor(await w.detect(), a.templateId, a.diskPath);

    expect(entry?.bucket).toBe('unchanged');
  });

  it('applies the selected update: new body on disk, old row superseded, current hash recorded', async () => {
    const w = world();
    const a = await installedBundleAgent(w, OLD_VERSION);
    const detected = await w.detect();
    const [entry] = w.entryFor(detected, a.templateId, a.diskPath);

    await recordWritten(
      upgradeApplyStep.apply(w.ctx, {
        detected: { ...detected, backfilledRows: 0 },
        formValues: { selectedUpdates: [entry!.entryId] },
        iteration: 0,
        previousIterations: [],
      }),
    );

    expect(await readFile(join(repo, a.diskPath), 'utf8')).toBe(
      buildAgentFileForTarget(AGENT, TARGET),
    );
    const rows = w.fake.rows(schema.onboardingArtifacts).filter((r) => r.diskPath === a.diskPath);
    expect(rows.find((r) => r.id === a.rowId)?.supersededAt).toBeInstanceOf(Date);
    const current = rows.filter((r) => r.supersededAt === null);
    expect(current).toHaveLength(1);
    expect(current[0]?.templateContentHash).toBe(bundleAgentTemplateHash(IR));
  });

  it('leaves a bundle skill recorded with its bare hash unchanged', async () => {
    const w = world();
    const itemId = w.addItem('skill', SKILL);
    const templateId = `custom.${w.bundleId}.${itemId}`;
    const diskPath = '.claude/skills/styling/SKILL.md';
    await w.put(diskPath, OLD_BYTES);
    w.record({
      diskPath,
      templateId,
      templateKind: 'custom-skill',
      schemaVersion: 1,
      contentHash: IR,
      bytes: OLD_BYTES,
      bundleItemId: itemId,
    });
    const [entry] = w.entryFor(await w.detect(), templateId, diskPath);

    expect(entry?.bucket).toBe('unchanged');
  });

  it('plans nothing for a bundle agent in a repository whose render context has no agent target', async () => {
    const w = world([]);
    const itemId = w.addItem('agent', AGENT);

    expect(w.entryFor(await w.detect(), `custom.${w.bundleId}.${itemId}`)).toEqual([]);
  });
});

describe('a renderer-version bump reaches built-in agents', () => {
  const manifestAgent = () => {
    const item = getTemplateManifest().items.find((i) => i.id === 'agent.code-reviewer')!;
    return { templateId: item.id, contentHash: item.contentHash };
  };
  const diskPath = '.claude/agents/code-reviewer.md';
  const installed = async (version: number) => {
    const w = world();
    const m = manifestAgent();
    await w.put(diskPath, OLD_BYTES);
    w.record({
      diskPath,
      templateId: m.templateId,
      templateKind: 'agent',
      schemaVersion: version,
      contentHash: m.contentHash,
      bytes: OLD_BYTES,
    });
    return { w, m };
  };

  it('plans a built-in agent recorded at the previous version as a clean update to its current rendering', async () => {
    // A built-in agent's schemaVersion is the renderer version, so a bump re-offers it.
    const { w, m } = await installed(OLD_VERSION);
    const [entry] = w.entryFor(await w.detect(), m.templateId, diskPath);
    const spec = BASELINE_AGENT_SPECS.find((s) => s.id === 'code-reviewer')!;

    expect(entry?.bucket).toBe('clean_update');
    expect(entry?.newContent).toBe(buildAgentFileForTarget(spec, TARGET));
  });

  it('plans a built-in agent recorded at the current version as unchanged', async () => {
    const { w, m } = await installed(AGENT_RENDERER_VERSION);
    const [entry] = w.entryFor(await w.detect(), m.templateId, diskPath);

    expect(entry?.bucket).toBe('unchanged');
  });
});
