import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepContext } from '../../step-definition.js';

const hasWorkspaceEntry = vi.fn();
const resolveDdevWorkspace = vi.fn();
const loadConfiguredLspLanguages = vi.fn();
const runInSandbox = vi.fn();
const resolveInvocationRepoMount = vi.fn();
const haiveDataBoundary = vi.fn();
const worktreesBoundary = vi.fn();

vi.mock('../../../sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/sandbox-runner.js')>()),
  runInSandbox: (...args: unknown[]) => runInSandbox(...args),
}));
vi.mock('../../../queues/cli-exec-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec-queue.js')>()),
  resolveAuthMounts: async () => [],
  resolveSandboxImageTag: async () => null,
  resolveInvocationRepoMount: (...args: unknown[]) => resolveInvocationRepoMount(...args),
}));
vi.mock('../../../queues/cli-exec/images.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec/images.js')>()),
  resolveSandboxImageTag: async () => null,
}));
vi.mock('../../../queues/cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec/secret-mask.js')>()),
  resolveSecretMasks: async () => [],
}));
vi.mock('../../../queues/cli-exec/gitfile-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec/gitfile-mask.js')>()),
  repoGitDataBoundary: async () => ({ mounts: [], masks: [] }),
}));
vi.mock('../../../queues/cli-exec/haive-data-boundary.js', () => ({
  haiveDataBoundary: (...args: unknown[]) => haiveDataBoundary(...args),
}));
vi.mock('../../../queues/cli-exec/worktrees-boundary.js', () => ({
  worktreesBoundary: (...args: unknown[]) => worktreesBoundary(...args),
}));

vi.mock('../../workspace-probe.js', () => ({
  hasWorkspaceEntry: (...args: unknown[]) => hasWorkspaceEntry(...args),
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  resolveDdevWorkspace: (...args: unknown[]) => resolveDdevWorkspace(...args),
}));
vi.mock('../../../lsp/configured-lsp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lsp/configured-lsp.js')>()),
  loadConfiguredLspLanguages: (...args: unknown[]) => loadConfiguredLspLanguages(...args),
}));

const { installPluginsStep } = await import('./01b-install-plugins.js');
type Ctx = StepContext;

const REPO = '/var/lib/haive/repos/u/r';
const WORKTREE = `${REPO}/.haive/worktrees/feature-x`;
const TREE_REL = '.claude/plugins/drupal-php-lsp';
const MARKETPLACE_JSON = `${TREE_REL}/.claude-plugin/marketplace.json`;
const PLUGIN_JSON = `${TREE_REL}/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json`;

function ctx(): Ctx {
  return {
    db: {
      query: {
        cliProviders: {
          findFirst: async () => ({ name: 'claude-code', wrapperPath: null, executablePath: null }),
        },
      },
    },
    taskId: 'task-1',
    cliProviderId: 'provider-1',
    repoPath: REPO,
    logger: { warn: vi.fn(), info: vi.fn() },
    emitProgress: vi.fn(),
  } as unknown as Ctx;
}

beforeEach(() => {
  resolveInvocationRepoMount.mockReset();
  resolveInvocationRepoMount.mockResolvedValue({
    repoMount: null,
    hasWorktree: false,
    hasRepo: false,
  });
  haiveDataBoundary.mockReset();
  haiveDataBoundary.mockResolvedValue([]);
  worktreesBoundary.mockReset();
  worktreesBoundary.mockResolvedValue([]);
  hasWorkspaceEntry.mockReset();
  resolveDdevWorkspace.mockReset();
  loadConfiguredLspLanguages.mockReset();
  resolveDdevWorkspace.mockResolvedValue({
    workspace: WORKTREE,
    repoSubpath: 'u/r/.haive/worktrees/feature-x',
  });
});

describe('01b-install-plugins detect: the local drupal-php-lsp tree', () => {
  it('registers the local marketplace when PHP LSP is configured and the tree is there', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['php-extended']);
    hasWorkspaceEntry.mockResolvedValue(true);

    const detected = await installPluginsStep.detect!(ctx());

    expect(detected.drupalLspPath).toBe(`/haive/workdir/${TREE_REL}`);
    expect(detected.commands).toHaveLength(2);
    expect(detected.skip).toBe(false);
  });

  it('skips instead of registering a path the sandbox cannot see', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['php-extended']);
    hasWorkspaceEntry.mockResolvedValue(false);

    const detected = await installPluginsStep.detect!(ctx());

    expect(hasWorkspaceEntry).toHaveBeenCalledWith(WORKTREE, MARKETPLACE_JSON);
    expect(detected.drupalLspPath).toBeNull();
    expect(detected.commands).toEqual([]);
    expect(detected.skip).toBe(true);
    expect(detected.skipReason).toContain(TREE_REL);
  });

  it('skips when only part of the tree is there', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['php-extended']);
    hasWorkspaceEntry.mockImplementation(
      async (_workspace: string, rel: string) => rel !== PLUGIN_JSON,
    );

    const detected = await installPluginsStep.detect!(ctx());

    expect(detected.drupalLspPath).toBeNull();
    expect(detected.commands).toEqual([]);
    expect(detected.skip).toBe(true);
    expect(detected.skipReason).toContain(TREE_REL);
  });

  it('does not take a bare base path for the tree', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['php-extended']);
    hasWorkspaceEntry.mockImplementation(
      async (_workspace: string, rel: string) => rel === TREE_REL,
    );

    const detected = await installPluginsStep.detect!(ctx());

    expect(detected.drupalLspPath).toBeNull();
    expect(detected.skip).toBe(true);
  });

  it('keeps the marketplace plugins for the other languages when the tree is missing', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['php-extended', 'typescript']);
    hasWorkspaceEntry.mockResolvedValue(false);

    const detected = await installPluginsStep.detect!(ctx());

    expect(detected.skip).toBe(false);
    expect(detected.commands.length).toBeGreaterThan(0);
    for (const command of detected.commands) {
      expect(`${command.description} ${command.args.join(' ')}`).not.toContain('drupal');
    }
  });

  it('treats a task with no workspace as having no tree', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['php-extended']);
    resolveDdevWorkspace.mockResolvedValue(null);

    const detected = await installPluginsStep.detect!(ctx());

    expect(hasWorkspaceEntry).not.toHaveBeenCalled();
    expect(detected.drupalLspPath).toBeNull();
    expect(detected.skip).toBe(true);
  });

  it('does not look for the tree when PHP LSP is not configured', async () => {
    loadConfiguredLspLanguages.mockResolvedValue(['typescript']);

    const detected = await installPluginsStep.detect!(ctx());

    expect(hasWorkspaceEntry).not.toHaveBeenCalled();
    expect(detected.drupalLspPath).toBeNull();
    expect(detected.skip).toBe(false);
  });
});

describe('01b-install-plugins apply: what the step records', () => {
  type ApplyArgs = Parameters<typeof installPluginsStep.apply>[1];

  function detectedWith(missingDrupalLsp: string | null): ApplyArgs {
    return {
      detected: {
        providerName: 'claude-code',
        providerSupportsPlugins: true,
        lspLanguages: ['php-extended', 'typescript'],
        drupalLspPath: null,
        missingDrupalLsp,
        commands: [
          {
            description: 'Add marketplace',
            command: 'claude',
            args: ['plugin', 'marketplace', 'add', 'x'],
          },
        ],
        skip: false,
        skipReason: null,
      },
    } as unknown as ApplyArgs;
  }

  it('records the PHP plugin it left out, so a partial install is not read as a ready bridge', async () => {
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const out = await installPluginsStep.apply(ctx(), detectedWith(TREE_REL));

    expect(out).toMatchObject({ skipped: false, missingDrupalLsp: TREE_REL });
  });

  it('labels each install container with the task, so Stop and the reaper find it', async () => {
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await installPluginsStep.apply(ctx(), detectedWith(null));

    expect(runInSandbox).toHaveBeenCalled();
    for (const call of runInSandbox.mock.calls) {
      expect(call[1]).toMatchObject({ taskId: ctx().taskId });
    }
  });

  it('mounts the .haive-data boundary the agent sandboxes get, under the repository mount', async () => {
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const repoMount = { source: 'haive_repos', target: '/haive/workdir', subpath: 'u/r/wt' };
    const boundary = [
      {
        source: 'haive_repos',
        target: '/haive/workdir/.haive-data',
        subpath: 'u/r/wt/.haive-data',
        readOnly: true,
      },
      {
        source: 'haive_repos',
        target: '/haive/workdir/.haive-data/learnings',
        subpath: 'u/r/wt/.haive-data/learnings',
      },
    ];
    resolveInvocationRepoMount.mockResolvedValue({ repoMount, hasWorktree: true, hasRepo: true });
    haiveDataBoundary.mockResolvedValue(boundary);

    await installPluginsStep.apply(ctx(), detectedWith(null));

    expect(haiveDataBoundary).toHaveBeenCalledWith(repoMount, { hasRepo: true });
    expect(runInSandbox).toHaveBeenCalled();
    for (const call of runInSandbox.mock.calls) {
      expect(call[1].extraMounts).toEqual([...boundary, repoMount]);
    }
  });

  it('keeps .haive/worktrees read-only for a repository root mount, ahead of the repository mount', async () => {
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const repoMount = { source: 'haive_repos', target: '/haive/workdir', subpath: 'u/r' };
    const boundary = [
      {
        source: 'haive_repos',
        target: '/haive/workdir/.haive-data',
        subpath: 'u/r/.haive-data',
        readOnly: true,
      },
    ];
    const worktrees = [
      {
        source: 'haive_repos',
        target: '/haive/workdir/.haive/worktrees',
        subpath: 'u/r/.haive/worktrees',
        readOnly: true,
      },
    ];
    resolveInvocationRepoMount.mockResolvedValue({ repoMount, hasWorktree: false, hasRepo: true });
    haiveDataBoundary.mockResolvedValue(boundary);
    worktreesBoundary.mockResolvedValue(worktrees);

    await installPluginsStep.apply(ctx(), detectedWith(null));

    expect(worktreesBoundary).toHaveBeenCalledWith(repoMount, {
      hasWorktree: false,
      hasRepo: true,
    });
    expect(runInSandbox).toHaveBeenCalled();
    for (const call of runInSandbox.mock.calls) {
      expect(call[1].extraMounts).toEqual([...boundary, ...worktrees, repoMount]);
    }
  });

  it('records nothing missing after a full install', async () => {
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const out = await installPluginsStep.apply(ctx(), detectedWith(null));

    expect(out).toMatchObject({ skipped: false, missingDrupalLsp: null });
  });
});

describe('01b-install-plugins apply: the network a CLI run gets', () => {
  const PROVIDER_POLICY = { mode: 'allowlist', domains: ['provider.example'], ips: [] };
  const TASK_POLICY = { mode: 'allowlist', domains: ['task.example'], ips: [] };

  function allowlistCtx(taskEgress: unknown): Ctx {
    return {
      ...ctx(),
      db: {
        query: {
          cliProviders: {
            findFirst: async () => ({
              id: 'provider-1',
              name: 'claude-code',
              wrapperPath: null,
              executablePath: null,
              networkPolicy: PROVIDER_POLICY,
              egressDomains: ['extra.example'],
            }),
          },
          tasks: {
            findFirst: async () => ({ metadata: taskEgress ? { egress: taskEgress } : {} }),
          },
        },
      },
    } as unknown as Ctx;
  }

  async function runApply(taskEgress: unknown) {
    loadConfiguredLspLanguages.mockResolvedValue(['typescript', 'php-extended']);
    hasWorkspaceEntry.mockResolvedValue(true);
    runInSandbox.mockReset();
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const c = allowlistCtx(taskEgress);
    const detected = await installPluginsStep.detect!(c);
    await installPluginsStep.apply(c, { detected } as unknown as Parameters<
      typeof installPluginsStep.apply
    >[1]);
    return detected.commands;
  }

  it("runs every command under the task's network override, as an agent run does", async () => {
    const commands = await runApply(TASK_POLICY);

    expect(runInSandbox).toHaveBeenCalledTimes(commands.length);
    for (const call of runInSandbox.mock.calls) {
      expect(call[1]).toMatchObject({ networkPolicy: TASK_POLICY });
    }
  });

  it('falls back to the provider policy when the task carries no override', async () => {
    await runApply(null);

    for (const call of runInSandbox.mock.calls) {
      expect(call[1]).toMatchObject({ networkPolicy: PROVIDER_POLICY });
    }
  });

  it("allows the CLI's own hosts plus each command's own hosts", async () => {
    const commands = await runApply(TASK_POLICY);

    expect(commands.length).toBeGreaterThan(0);
    commands.forEach((cmd, i) => {
      const egress = (runInSandbox.mock.calls[i]![1] as { egressDomains?: string[] }).egressDomains;
      expect(egress).toEqual(expect.arrayContaining(['api.anthropic.com', 'extra.example']));
      expect(egress).toEqual(expect.arrayContaining(cmd.egressDomains ?? []));
    });
    const marketplace = commands.findIndex((c) => c.args.includes('Piebald-AI/claude-code-lsps'));
    expect(marketplace).toBeGreaterThanOrEqual(0);
    const marketplaceEgress = (
      runInSandbox.mock.calls[marketplace]![1] as { egressDomains?: string[] }
    ).egressDomains;
    expect(marketplaceEgress).toContain('github.com');
  });

  it('adds nothing to a local-path marketplace command beyond the CLI hosts', async () => {
    const commands = await runApply(TASK_POLICY);

    const local = commands.findIndex((c) => c.description.includes('local drupal-lsp'));
    expect(local).toBeGreaterThanOrEqual(0);
    const egress = (runInSandbox.mock.calls[local]![1] as { egressDomains?: string[] })
      .egressDomains;
    expect(egress).not.toContain('github.com');
  });
});
