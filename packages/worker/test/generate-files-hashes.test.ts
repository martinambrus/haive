import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger, normalizeContent, sha256Hex } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { AgentRenderTarget } from '../src/step-engine/steps/onboarding/_agent-templates.js';
import {
  generateFilesStep,
  type GenerateFilesDetect,
  type ProjectInfo,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';

/**
 * What 07 RECORDS about the bytes it wrote.
 *
 * The onboarding reset reads these hashes to tell a generated file the user has since edited
 * from one still holding what Haive put there, and it is the only evidence there is for the
 * outputs no manifest covers. Every test on the reading side feeds the field synthetically, so
 * without these three 07 could stop emitting it — or emit it normalised differently — and the
 * whole api-side suite would still pass while the gate quietly stopped firing.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-genhash-'));
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
    logger: logger.child({ test: 'generate-files-hashes' }),
    emitProgress: async () => {},
  } as unknown as StepContext;
}

const CONFIG = '.claude/workflow-config.json';

describe('generateFilesStep.apply — recorded write hashes', () => {
  it('records, for a file it wrote, the hash of the bytes that are on disk', async () => {
    const out = await generateFilesStep.apply(ctx(), {
      iteration: 0,
      previousIterations: [],
      detected: detect(),
      formValues: {},
    });

    // Derived from the FILE, not from the value 07 passed itself: the reset compares against
    // disk, so a hash taken over anything else is one that can never match. This is also what
    // pins the normalisation — the two sides agreeing is the whole mechanism.
    const onDisk = await readFile(path.join(repo, CONFIG), 'utf8');
    expect(out.wroteFiles).toContain(CONFIG);
    expect(out.wroteFileHashes?.[CONFIG]).toBe(sha256Hex(normalizeContent(onDisk)));
  });

  it('records NOTHING for a file it skipped', async () => {
    // The property the whole claim rests on. `overwrite` defaults to false, so a pre-existing
    // file is left alone — and because no hash is recorded for it, a recorded hash is proof that
    // 07 authored the bytes rather than merely that it could have rendered them. A row cannot
    // say that, which is why the reset trusts the two differently.
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, CONFIG), '{"mine":true}', 'utf8');

    const out = await generateFilesStep.apply(ctx(), {
      iteration: 0,
      previousIterations: [],
      detected: detect(),
      formValues: {},
    });

    expect(out.skippedFiles).toContain(CONFIG);
    expect(out.wroteFileHashes?.[CONFIG]).toBeUndefined();
    // Untouched, which is the behaviour the absent hash describes.
    expect(await readFile(path.join(repo, CONFIG), 'utf8')).toBe('{"mine":true}');
  });

  it('records no hash for a root rules file, which holds the user’s own text', async () => {
    // AGENTS.md is written around a marker block, so its bytes are never wholly Haive's. Hashing
    // the block under the file's path would store a digest that can never match the file — the
    // trap 12-post-onboarding already carries for its own AGENTS.md row. It costs nothing,
    // because a root path is claimed by neither arm of the reset's `claimPath`.
    const out = await generateFilesStep.apply(ctx(), {
      iteration: 0,
      previousIterations: [],
      detected: detect(),
      formValues: {},
    });

    expect(out.wroteFiles).toContain('AGENTS.md');
    expect(out.wroteFileHashes?.['AGENTS.md']).toBeUndefined();
  });
});
