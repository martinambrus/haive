import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  buildClaudeSettingsJson,
  buildGeminiSettingsJson,
} from '@haive/shared';
import type { StepContext } from '../../src/step-engine/step-definition.js';

export const USER = '00000000-0000-4000-8000-0000000000a1';
export const REPO = '00000000-0000-4000-8000-0000000000b1';
export const TASK = '00000000-0000-4000-8000-0000000000c1';
export const ONBOARDING = '00000000-0000-4000-8000-0000000000d1';

/** The tables 01's `detect` and `apply` read and write. */
export function newDb() {
  return createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
  });
}
export type Fake = ReturnType<typeof newDb>;

export interface ProviderSeed {
  name: string;
  enabled: boolean;
}

/** What the upgrading user has: claude-code and codex on, gemini off. */
export const PROVIDERS: ProviderSeed[] = [
  { name: 'claude-code', enabled: true },
  { name: 'codex', enabled: true },
  { name: 'gemini', enabled: false },
];

export function seedProviders(fake: Fake, providers: ProviderSeed[] = PROVIDERS): void {
  for (const p of providers) {
    fake.insert(schema.cliProviders, {
      userId: USER,
      name: p.name,
      label: p.name,
      enabled: p.enabled,
      rulesContent: '',
    });
  }
}

/** The repository row and the upgrade task 01 runs for. The fake applies no column default, so every
 *  column a reader selects is named here. */
export function seedRepository(
  fake: Fake,
  args: { source: string; rtkEnabled: boolean; renderContext?: unknown },
): void {
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: args.source,
    status: 'ready',
    rtkEnabled: args.rtkEnabled,
    renderContext: args.renderContext ?? null,
    applicableTemplateIds: null,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding_upgrade',
    status: 'running',
    title: 'upgrade',
  });
}

/** One live artifact row carrying `snapshot` as its render-context snapshot. */
export function seedLiveRow(
  fake: Fake,
  args: { path: string; snapshot: Record<string, unknown> | null; at: number },
): void {
  fake.insert(schema.onboardingArtifacts, {
    userId: USER,
    repositoryId: REPO,
    taskId: ONBOARDING,
    diskPath: args.path,
    templateId: 'agent.x',
    templateKind: 'agent',
    templateSchemaVersion: 1,
    templateContentHash: 'h1',
    writtenHash: 'w1',
    userModified: false,
    formValuesSnapshot: args.snapshot,
    sourceStepId: '12-post-onboarding',
    source: 'onboarding',
    haiveVersion: null,
    generatedAt: new Date(args.at),
    supersededAt: null,
    bundleItemId: null,
  });
}

/** A completed onboarding task, with the 07-generate-files step row when `detect` is given. */
export function seedOnboarding(fake: Fake, detect?: Record<string, unknown>): void {
  fake.insert(schema.tasks, {
    id: ONBOARDING,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    status: 'completed',
    completedAt: new Date(5000),
    title: 'onboarding',
  });
  if (detect) {
    fake.insert(schema.taskSteps, {
      taskId: ONBOARDING,
      stepId: '07-generate-files',
      detectOutput: detect,
    });
  }
}

export interface LoggerCalls {
  calls: { level: string; args: unknown[] }[];
}

export function ctxFor(fake: Fake, repoPath: string, logs?: LoggerCalls): StepContext {
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      logs?.calls.push({ level, args });
    };
  return {
    round: 0,
    taskId: TASK,
    taskStepId: '00000000-0000-4000-8000-0000000000e1',
    userId: USER,
    repoPath,
    workspacePath: repoPath,
    sandboxWorkdir: '/haive/workdir',
    cliProviderId: null,
    db: fake.db,
    logger: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') },
    signal: new AbortController().signal,
    throwIfCancelled: () => undefined,
    async emitProgress() {},
  } as unknown as StepContext;
}

export const RTK_BLOCK = `${RTK_REF_MARKER_START}\nRTK is here.\n${RTK_REF_MARKER_END}\n`;

/** A checkout that still carries RTK: its block in AGENTS.md and the hook in both settings files. */
export async function writeRtkRepo(dir: string): Promise<void> {
  await mkdir(join(dir, '.claude'), { recursive: true });
  await mkdir(join(dir, '.gemini'), { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), `# rules\n${RTK_BLOCK}`, 'utf8');
  await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
  await writeFile(join(dir, '.claude/settings.json'), buildClaudeSettingsJson(), 'utf8');
  await writeFile(join(dir, '.gemini/settings.json'), buildGeminiSettingsJson(), 'utf8');
}
