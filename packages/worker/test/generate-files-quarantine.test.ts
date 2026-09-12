import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  stubCustomAgent,
  type AgentRenderTarget,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';
import {
  findUnmanagedAgentFiles,
  generateFilesStep,
  type GenerateFilesDetect,
  type ProjectInfo,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-quarantine-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

const CLAUDE: AgentRenderTarget = { dir: '.claude/agents', format: 'markdown', supportsLsp: true };
const CODEX: AgentRenderTarget = { dir: '.codex/agents', format: 'toml', supportsLsp: false };

async function seed(rel: string, contents = 'x'): Promise<void> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

describe('findUnmanagedAgentFiles', () => {
  it('reports a definition this run does not manage and keeps the ones it does', async () => {
    await seed('.claude/agents/peer-reviewer.md');
    await seed('.claude/agents/README.md');
    await seed('.claude/agents/drupal7-developer.md');
    await seed('.claude/agents/sprint-planner.md');

    const found = await findUnmanagedAgentFiles(
      repo,
      [CLAUDE],
      [stubCustomAgent('peer-reviewer')],
      new Set(),
    );
    expect(found).toEqual([
      { dir: '.claude/agents', files: ['drupal7-developer.md', 'sprint-planner.md'] },
    ]);
  });

  it('never reports a path a live onboarding_artifacts row claims', async () => {
    await seed('.claude/agents/api-route-dev.md');
    await seed('.claude/agents/merger.md');

    const found = await findUnmanagedAgentFiles(
      repo,
      [CLAUDE],
      [],
      new Set(['.claude/agents/api-route-dev.md']),
    );
    expect(found).toEqual([{ dir: '.claude/agents', files: ['merger.md'] }]);
  });

  it('judges each target by the extension its own CLI reads', async () => {
    await seed('.codex/agents/legacy.toml');
    await seed('.codex/agents/notes.md');

    const found = await findUnmanagedAgentFiles(repo, [CODEX], [], new Set());
    expect(found).toEqual([{ dir: '.codex/agents', files: ['legacy.toml'] }]);
  });

  it('leaves a subdirectory alone and answers nothing for a dir that does not exist', async () => {
    await seed('.claude/agents/nested/deep.md');
    expect(await findUnmanagedAgentFiles(repo, [CLAUDE], [], new Set())).toEqual([]);
    expect(await findUnmanagedAgentFiles(repo, [CODEX], [], new Set())).toEqual([]);
  });
});

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

function detectWith(unmanaged: { dir: string; files: string[] }[]): GenerateFilesDetect {
  return {
    framework: null,
    language: null,
    projectName: 'demo',
    projectInfo: PROJECT_INFO,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    mcpSettingsJson: '',
    cliProviders: [],
    agentTargets: [CLAUDE],
    plannedAgents: [],
    existingFiles: [],
    unmanagedAgentFiles: unmanaged,
    rtkEnabled: false,
    enabledCliProviders: [],
  };
}

function ctx(): StepContext {
  return {
    taskId: 't1',
    taskStepId: 'ts1',
    userId: 'u1',
    repoPath: repo,
    workspacePath: repo,
    cliProviderId: null,
    logger: logger.child({ test: 'generate-files-quarantine' }),
    emitProgress: async () => {},
  } as unknown as StepContext;
}

describe('generateFilesStep.apply — quarantine', () => {
  const unmanaged = [{ dir: '.claude/agents', files: ['drupal7-developer.md'] }];

  it('moves nothing when the box is left unticked', async () => {
    await seed('.claude/agents/drupal7-developer.md', 'legacy body');
    const out = await generateFilesStep.apply(ctx(), {
      detected: detectWith(unmanaged),
      formValues: {},
    });
    expect(out.quarantinedAgentFiles).toBeUndefined();
    expect(await readFile(path.join(repo, '.claude/agents/drupal7-developer.md'), 'utf8')).toBe(
      'legacy body',
    );
  });

  it('moves the file to the sibling dir verbatim and leaves a README that says how to undo', async () => {
    await seed('.claude/agents/drupal7-developer.md', 'legacy body');
    const out = await generateFilesStep.apply(ctx(), {
      detected: detectWith(unmanaged),
      formValues: { quarantineUnmanagedAgents: true },
    });
    expect(out.quarantinedAgentFiles).toEqual([
      {
        from: '.claude/agents/drupal7-developer.md',
        to: '.claude/agents-legacy/drupal7-developer.md',
      },
    ]);
    expect(
      await readFile(path.join(repo, '.claude/agents-legacy/drupal7-developer.md'), 'utf8'),
    ).toBe('legacy body');
    await expect(
      readFile(path.join(repo, '.claude/agents/drupal7-developer.md'), 'utf8'),
    ).rejects.toThrow();
    const readme = await readFile(path.join(repo, '.claude/agents-legacy/README.md'), 'utf8');
    expect(readme).toContain('git mv .claude/agents-legacy/<name> .claude/agents/<name>');
  });

  it('refuses to overwrite a name already quarantined and reports it as skipped', async () => {
    await seed('.claude/agents/drupal7-developer.md', 'newer');
    await seed('.claude/agents-legacy/drupal7-developer.md', 'older');
    const out = await generateFilesStep.apply(ctx(), {
      detected: detectWith(unmanaged),
      formValues: { quarantineUnmanagedAgents: true },
    });
    expect(out.quarantinedAgentFiles).toBeUndefined();
    expect(out.skippedFiles).toContain('.claude/agents/drupal7-developer.md');
    expect(
      await readFile(path.join(repo, '.claude/agents-legacy/drupal7-developer.md'), 'utf8'),
    ).toBe('older');
    expect(await readFile(path.join(repo, '.claude/agents/drupal7-developer.md'), 'utf8')).toBe(
      'newer',
    );
  });
});
