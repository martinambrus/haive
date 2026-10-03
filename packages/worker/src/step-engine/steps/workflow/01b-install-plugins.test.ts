import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepContext } from '../../step-definition.js';

const hasWorkspaceEntry = vi.fn();
const resolveDdevWorkspace = vi.fn();
const loadConfiguredLspLanguages = vi.fn();

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

    expect(hasWorkspaceEntry).toHaveBeenCalledWith(WORKTREE, TREE_REL);
    expect(detected.drupalLspPath).toBeNull();
    expect(detected.commands).toEqual([]);
    expect(detected.skip).toBe(true);
    expect(detected.skipReason).toContain(TREE_REL);
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
