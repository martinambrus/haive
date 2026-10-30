import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  buildRepoCliRulesBlock,
  CLI_RULES_END,
  CLI_RULES_START,
  extractRegion,
  logger,
} from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { AgentRenderTarget } from '../src/step-engine/steps/onboarding/_agent-templates.js';
import {
  generateFilesStep,
  type GenerateFilesDetect,
  type ProjectInfo,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';
import { RULES_TASK, RULES_USER, rulesOverrideDb } from './support/rules-override-db.js';

// 07 renders the AGENTS.md rules region from the REPOSITORY's override, read live when it applies:
// the providers of the person onboarding decide which CLI files exist, never what the region says.

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-genrules-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

const CLAUDE: AgentRenderTarget = { dir: '.claude/agents', format: 'markdown', supportsLsp: true };

const PROJECT_INFO: ProjectInfo = {
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
};

function detect(providers: GenerateFilesDetect['cliProviders']): GenerateFilesDetect {
  return {
    framework: null,
    language: null,
    projectName: 'demo',
    projectInfo: PROJECT_INFO,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    mcpSettingsJson: '',
    cliProviders: providers,
    agentTargets: [CLAUDE],
    plannedAgents: [],
    existingFiles: [],
    unmanagedAgentFiles: [],
    rtkEnabled: false,
    enabledCliProviders: [],
  };
}

function ctx(db: unknown, userId = RULES_USER): StepContext {
  return {
    db,
    taskId: RULES_TASK,
    taskStepId: 'ts1',
    userId,
    repoPath: repo,
    workspacePath: repo,
    cliProviderId: null,
    logger: logger.child({ test: 'generate-files-agent-rules' }),
    emitProgress: async () => {},
  } as unknown as StepContext;
}

const apply = (context: StepContext, detected: GenerateFilesDetect) =>
  generateFilesStep.apply(context, {
    iteration: 0,
    previousIterations: [],
    detected,
    formValues: {},
  });

const regionOnDisk = async (): Promise<string | null> =>
  extractRegion(
    await readFile(path.join(repo, 'AGENTS.md'), 'utf8'),
    CLI_RULES_START,
    CLI_RULES_END,
  );

describe('generateFilesStep.apply — the rules region', () => {
  it('writes the override the repository holds, and returns it', async () => {
    const out = await apply(
      ctx(rulesOverrideDb('- the repository rule').db),
      detect([{ name: 'claude-code' }]),
    );

    const agents = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('- the repository rule');
    expect(await regionOnDisk()).toBe(
      extractRegion(
        buildRepoCliRulesBlock('- the repository rule')!,
        CLI_RULES_START,
        CLI_RULES_END,
      ),
    );
    expect(out.agentRulesOverride).toBe('- the repository rule');
  });

  it('writes an override that repeats a line as saved, every occurrence of it', async () => {
    const override =
      '# Rules\n\nRun the tests before you finish.\n\n    cd packages/api\n    pnpm test\n    cd ../web\n    pnpm test\n\nRun the tests before you finish.\n';
    await apply(ctx(rulesOverrideDb(override).db), detect([{ name: 'claude-code' }]));

    expect(await regionOnDisk()).toBe(`${CLI_RULES_START}\n${override}${CLI_RULES_END}`);
  });

  it('writes the default rules for a repository with no override, and returns null', async () => {
    const out = await apply(ctx(rulesOverrideDb(null).db), detect([{ name: 'claude-code' }]));

    expect(await regionOnDisk()).toBe(
      extractRegion(buildRepoCliRulesBlock(null)!, CLI_RULES_START, CLI_RULES_END),
    );
    expect(out.agentRulesOverride).toBeNull();
  });

  it('writes no region for an empty override, keeps the project info and the CLAUDE.md import, and returns the empty string', async () => {
    const out = await apply(ctx(rulesOverrideDb('').db), detect([{ name: 'claude-code' }]));

    const agents = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain(CLI_RULES_START);
    expect(agents).toContain('haive:project-info');
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
    expect(out.agentRulesOverride).toBe('');
  });

  it('reads the default rules for a task with no repository', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, repositories: schema.repositories });
    fake.insert(schema.tasks, {
      id: RULES_TASK,
      userId: RULES_USER,
      repositoryId: null,
      type: 'onboarding',
      status: 'running',
      title: 'onboarding',
    });

    const out = await apply(ctx(fake.db), detect([{ name: 'claude-code' }]));

    expect(await regionOnDisk()).toBe(
      extractRegion(buildRepoCliRulesBlock(null)!, CLI_RULES_START, CLI_RULES_END),
    );
    expect(out.agentRulesOverride).toBeNull();
  });

  it('writes the same region for two people with different CLIs on one repository', async () => {
    const first = await apply(
      ctx(rulesOverrideDb('- shared rule').db),
      detect([{ name: 'claude-code' }]),
    );
    const regionA = await regionOnDisk();
    await rm(path.join(repo, 'AGENTS.md'));

    const second = await apply(
      ctx(rulesOverrideDb('- shared rule').db, '00000000-0000-4000-8000-0000000000a2'),
      detect([{ name: 'codex' }, { name: 'gemini' }]),
    );
    const regionB = await regionOnDisk();

    expect(regionA).not.toBeNull();
    expect(regionB).toBe(regionA);
    expect(second.agentRulesOverride).toBe(first.agentRulesOverride);
  });
});
