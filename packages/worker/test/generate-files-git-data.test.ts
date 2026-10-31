import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { namesGitData } from '@haive/shared/project-state';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { AgentRenderTarget } from '../src/step-engine/steps/onboarding/_agent-templates.js';
import { RULES_TASK, RULES_USER, rulesOverrideDb } from './support/rules-override-db.js';
import {
  generateFilesStep,
  type GenerateFilesApply,
  type GenerateFilesDetect,
  type ProjectInfo,
} from '../src/step-engine/steps/onboarding/07-generate-files.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-gengit-'));
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

function detect(
  agentTargets: AgentRenderTarget[],
  rest: Partial<GenerateFilesDetect> = {},
): GenerateFilesDetect {
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
    agentTargets,
    plannedAgents: [],
    existingFiles: [],
    unmanagedAgentFiles: [],
    rtkEnabled: false,
    enabledCliProviders: [],
    ...rest,
  };
}

async function seed(rel: string, contents = 'x'): Promise<void> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

async function read(rel: string): Promise<string | null> {
  return readFile(path.join(repo, rel), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

async function exists(rel: string): Promise<boolean> {
  try {
    await lstat(path.join(repo, rel));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Runs 07's apply on `repo` with a recording logger, so a refusal is asserted by what it logged. */
async function applyWith(detected: GenerateFilesDetect, formValues: Record<string, unknown> = {}) {
  const warn = vi.fn();
  const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: (): unknown => log };
  const ctx = {
    db: rulesOverrideDb().db,
    taskId: RULES_TASK,
    taskStepId: 'ts1',
    userId: RULES_USER,
    repoPath: repo,
    workspacePath: repo,
    cliProviderId: null,
    logger: log,
    emitProgress: async () => {},
  } as unknown as StepContext;
  const out = await generateFilesStep.apply(ctx, {
    iteration: 0,
    previousIterations: [],
    detected,
    formValues,
  });
  // Read off the logged object's `rel`, never the message, whose wording is not the contract.
  const warnedRels = warn.mock.calls
    .map(([fields]) => (fields as { rel?: unknown } | undefined)?.rel)
    .filter((rel): rel is string => typeof rel === 'string')
    .sort();
  return { out, warn, warnedRels };
}

/** Every path 07 claims to have written, by either of its two records. */
const recorded = (out: GenerateFilesApply): string[] => [
  ...out.wroteFiles,
  ...Object.keys(out.wroteFileHashes ?? {}),
];

describe('07 stored agent destinations must be catalog directories', () => {
  const invalidDirs = ['', '.', 'other/agents', '.claude/agents/../agents', '.claude/skills'];

  it.each(invalidDirs)('refuses agent files and the index at %j', async (dir) => {
    await seed('README.md', 'root README');
    const { out, warn } = await applyWith(
      detect([{ dir, format: 'markdown' }, CLAUDE], {
        acceptedAgentIds: ['code-reviewer'],
        plannedAgents: ['code-reviewer'],
      }),
      { overwrite: true },
    );
    expect.soft(await exists('code-reviewer.md')).toBe(false);
    expect.soft(await read('README.md')).toBe('root README');
    expect.soft(recorded(out)).not.toContain(`${dir}/code-reviewer.md`);
    expect.soft(recorded(out)).not.toContain(`${dir}/README.md`);
    expect(out.skippedFiles).toEqual(
      expect.arrayContaining([`${dir}/code-reviewer.md`, `${dir}/README.md`]),
    );
    expect(warn).toHaveBeenCalled();
    expect(await exists('.claude/agents/code-reviewer.md')).toBe(true);
    expect(await exists('.claude/agents/README.md')).toBe(true);
  });

  it.each(invalidDirs)('refuses quarantine moves and their README at %j', async (dir) => {
    await seed(`${dir}/old.md`, 'keep original');
    await seed('.claude/agents/movable.md', 'move ordinary');
    const { out, warn } = await applyWith(
      detect([CLAUDE], {
        unmanagedAgentFiles: [
          { dir, files: ['old.md'] },
          { dir: '.claude/agents', files: ['movable.md'] },
        ],
      }),
      { quarantineUnmanagedAgents: true },
    );
    expect.soft(await read(`${dir}/old.md`)).toBe('keep original');
    expect.soft(await exists(`${dir}-legacy/old.md`)).toBe(false);
    expect(recorded(out)).not.toContain(`${dir}-legacy/README.md`);
    expect(out.quarantinedAgentFiles).toEqual([
      { from: '.claude/agents/movable.md', to: '.claude/agents-legacy/movable.md' },
    ]);
    expect(out.skippedFiles).toContain(`${dir}/old.md`);
    expect(warn).toHaveBeenCalled();
  });

  it('offers quarantine only for catalog groups', async () => {
    const form = await generateFilesStep.form!(
      {} as StepContext,
      detect([CLAUDE], {
        unmanagedAgentFiles: [
          ...invalidDirs.map((dir) => ({ dir, files: ['refused.md'] })),
          { dir: CLAUDE.dir, files: ['ordinary.md'] },
        ],
      }),
    );
    const field = form!.fields.find((f) => f.id === 'quarantineUnmanagedAgents');
    expect(field?.label).toContain('Move 1 unmanaged');
    expect(field?.description).toContain('ordinary.md');
    expect(field?.description).not.toContain('refused.md');
  });
});

/** 07 takes these paths from the stored detect payload, which nothing validated, so a legacy or
 *  hand-edited one can name git data. */
describe('generateFilesStep.apply — paths that name git data', () => {
  it('writes no agent file or index under a target that names git data', async () => {
    await seed('.git/hooks/pre-commit');

    const { out, warnedRels } = await applyWith(
      detect(
        [
          { dir: '.git/hooks', format: 'markdown' },
          { dir: '.GIT./hooks', format: 'markdown' },
          { dir: 'git~1/hooks', format: 'toml' },
          CLAUDE,
        ],
        { acceptedAgentIds: ['code-reviewer'], plannedAgents: ['code-reviewer'] },
      ),
    );

    expect((await readdir(path.join(repo, '.git/hooks'))).sort()).toEqual(['pre-commit']);
    expect(await exists('.GIT.')).toBe(false);
    expect(await exists('git~1')).toBe(false);

    const ordinary = ['.claude/agents/code-reviewer.md', '.claude/agents/README.md'];
    for (const rel of ordinary) expect(await exists(rel)).toBe(true);
    expect(recorded(out).filter((p) => namesGitData(p))).toEqual([]);
    expect(out.wroteFiles).toEqual(expect.arrayContaining(ordinary));
    expect(Object.keys(out.wroteFileHashes ?? {})).toEqual(expect.arrayContaining(ordinary));

    const refused = [
      '.git/hooks/code-reviewer.md',
      '.git/hooks/README.md',
      '.GIT./hooks/code-reviewer.md',
      '.GIT./hooks/README.md',
      'git~1/hooks/code-reviewer.toml',
      'git~1/hooks/README.md',
    ];
    expect(out.skippedFiles).toEqual(expect.arrayContaining(refused));
    expect(out.leftAsIs).toEqual([]);
    expect(warnedRels).toEqual([...refused].sort());
  });

  it('moves nothing out of a directory that names git data', async () => {
    const held = {
      '.git/hooks/old.md': 'git body',
      '.GIT./hooks/old.md': 'alias body',
      'sub/.git/old.md': 'nested body',
    };
    for (const [rel, body] of Object.entries(held)) await seed(rel, body);
    await seed('.claude/agents/old.md', 'legacy body');

    const { out, warnedRels } = await applyWith(
      detect([CLAUDE], {
        unmanagedAgentFiles: [
          { dir: '.git/hooks', files: ['old.md'] },
          { dir: '.GIT./hooks', files: ['old.md'] },
          { dir: 'sub/.git', files: ['old.md'] },
          { dir: '.claude/agents', files: ['old.md'] },
        ],
      }),
      { quarantineUnmanagedAgents: true },
    );

    for (const [rel, body] of Object.entries(held)) expect(await read(rel)).toBe(body);
    // `sub/.git-legacy/old.md` would not itself name git data: only the file it came from does.
    for (const legacy of ['.git/hooks-legacy', '.GIT./hooks-legacy', 'sub/.git-legacy']) {
      expect(await exists(legacy)).toBe(false);
    }
    expect(await read('.claude/agents-legacy/old.md')).toBe('legacy body');
    expect(await exists('.claude/agents/old.md')).toBe(false);
    expect(out.quarantinedAgentFiles).toEqual([
      { from: '.claude/agents/old.md', to: '.claude/agents-legacy/old.md' },
    ]);
    expect(recorded(out).filter((p) => namesGitData(p))).toEqual([]);

    const refused = Object.keys(held);
    expect(out.skippedFiles).toEqual(expect.arrayContaining(refused));
    expect(out.leftAsIs).toEqual([]);
    expect(warnedRels).toEqual([...refused].sort());
  });

  it('refuses nothing in an ordinary payload', async () => {
    await seed('.claude/agents/old.md', 'legacy body');

    const { out, warn } = await applyWith(
      detect([CLAUDE], {
        acceptedAgentIds: ['code-reviewer'],
        plannedAgents: ['code-reviewer'],
        unmanagedAgentFiles: [{ dir: '.claude/agents', files: ['old.md'] }],
      }),
      { quarantineUnmanagedAgents: true },
    );

    const written = [
      '.claude/agents/code-reviewer.md',
      '.claude/agents/README.md',
      '.claude/agents-legacy/README.md',
    ];
    for (const rel of written) expect(await exists(rel)).toBe(true);
    expect(out.wroteFiles).toEqual(expect.arrayContaining(written));
    expect(Object.keys(out.wroteFileHashes ?? {})).toEqual(expect.arrayContaining(written));
    expect(await read('.claude/agents-legacy/old.md')).toBe('legacy body');
    expect(out.quarantinedAgentFiles).toEqual([
      { from: '.claude/agents/old.md', to: '.claude/agents-legacy/old.md' },
    ]);
    expect(out.skippedFiles).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('07 quarantine form with stored git-data groups', () => {
  it('counts and describes only groups apply can quarantine', async () => {
    const form = await generateFilesStep.form!(
      {} as StepContext,
      detect([CLAUDE], {
        unmanagedAgentFiles: [
          { dir: '.git/hooks', files: ['private.md', 'other.md'] },
          { dir: '.GIT./hooks', files: ['alias.md'] },
          { dir: '.claude/agents', files: ['old.md'] },
        ],
      }),
    );
    const field = form!.fields.find((f) => f.id === 'quarantineUnmanagedAgents');
    expect(field?.label).toContain('Move 1 unmanaged');
    expect(field?.description).toContain('old.md');
    expect(field?.description).not.toMatch(/private|alias|\.git|\.GIT/);
  });
  it('offers no quarantine checkbox for git-data-only groups', async () => {
    const form = await generateFilesStep.form!(
      {} as StepContext,
      detect([CLAUDE], {
        unmanagedAgentFiles: [{ dir: '.git/hooks', files: ['private.md'] }],
      }),
    );
    expect(form!.fields.some((f) => f.id === 'quarantineUnmanagedAgents')).toBe(false);
  });
});
