import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepContext } from '../../step-definition.js';

const hasWorkspaceEntry = vi.fn();
const resolveDdevWorkspace = vi.fn();
const loadConfiguredLspLanguages = vi.fn();
const runInSandbox = vi.fn();

vi.mock('../../../sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/sandbox-runner.js')>()),
  runInSandbox: (...args: unknown[]) => runInSandbox(...args),
}));
vi.mock('../../../queues/cli-exec-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec-queue.js')>()),
  resolveAuthMounts: async () => [],
  resolveSandboxImageTag: async () => null,
  resolveInvocationRepoMount: async () => ({ repoMount: null, hasWorktree: false, hasRepo: false }),
}));
vi.mock('../../../queues/cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec/secret-mask.js')>()),
  resolveSecretMasks: async () => [],
}));
vi.mock('../../../queues/cli-exec/gitfile-mask.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queues/cli-exec/gitfile-mask.js')>()),
  repoGitDataBoundary: async () => ({ mounts: [], masks: [] }),
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

  it('records nothing missing after a full install', async () => {
    runInSandbox.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const out = await installPluginsStep.apply(ctx(), detectedWith(null));

    expect(out).toMatchObject({ skipped: false, missingDrupalLsp: null });
  });
});
