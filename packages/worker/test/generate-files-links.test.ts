import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { AgentRenderTarget } from '../src/step-engine/steps/onboarding/_agent-templates.js';
import {
  generateFilesStep,
  type GenerateFilesDetect,
  type ProjectInfo,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';

let repo: string;
let outside: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-genlinks-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'haive-genlinks-out-'));
  await writeFile(path.join(outside, 'elsewhere.md'), 'not ours', 'utf8');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
  await rm(outside, { recursive: true, force: true }).catch(() => {});
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

/** claude-code is the provider whose rules file is an IMPORT (`CLAUDE.md` holding `@AGENTS.md`),
 *  which is exactly the file a repo may already be symlinking to AGENTS.md. */
function detect(): GenerateFilesDetect {
  return {
    framework: null,
    language: null,
    projectName: 'demo',
    projectInfo: PROJECT_INFO,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    mcpSettingsJson: '',
    cliProviders: [{ name: 'claude-code', rulesContent: '- rule one' }],
    agentTargets: [CLAUDE],
    plannedAgents: [],
    existingFiles: [],
    unmanagedAgentFiles: [],
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
    logger: logger.child({ test: 'generate-files-links' }),
    emitProgress: async () => {},
  } as unknown as StepContext;
}

describe('generateFilesStep.apply — rules files that are links', () => {
  it('skips a CLAUDE.md that merely points at AGENTS.md, leaving the link intact', async () => {
    await symlink('AGENTS.md', path.join(repo, 'CLAUDE.md'));

    const out = await generateFilesStep.apply(ctx(), { detected: detect(), formValues: {} });

    // The link is left exactly as the repo had it — the content it names is written at its own path.
    expect(await readlink(path.join(repo, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(out.skippedFiles).toContain('CLAUDE.md');
    const agents = await readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('- rule one');
  });

  it('accepts the ./AGENTS.md spelling of the same convention', async () => {
    await symlink('./AGENTS.md', path.join(repo, 'CLAUDE.md'));

    const out = await generateFilesStep.apply(ctx(), { detected: detect(), formValues: {} });

    expect(await readlink(path.join(repo, 'CLAUDE.md'))).toBe('./AGENTS.md');
    expect(out.skippedFiles).toContain('CLAUDE.md');
  });

  it('refuses a rules file linked anywhere else and writes nothing through it', async () => {
    await symlink(path.join(outside, 'elsewhere.md'), path.join(repo, 'CLAUDE.md'));

    await expect(
      generateFilesStep.apply(ctx(), { detected: detect(), formValues: {} }),
    ).rejects.toMatchObject({ reason: 'link' });

    // The point of the refusal: the file the link named is untouched.
    expect(await readFile(path.join(outside, 'elsewhere.md'), 'utf8')).toBe('not ours');
  });

  it('writes CLAUDE.md normally when it is a real file', async () => {
    const out = await generateFilesStep.apply(ctx(), { detected: detect(), formValues: {} });

    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
    expect(out.skippedFiles ?? []).not.toContain('CLAUDE.md');
  });
});
