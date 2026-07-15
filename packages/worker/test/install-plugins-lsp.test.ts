import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { parseConfiguredLspLanguages } from '../src/step-engine/steps/workflow/01b-install-plugins.js';
import { hasReadyLspBridge, loadConfiguredLspLanguages } from '../src/lsp/configured-lsp.js';

function environmentDb(
  envTemplate: { declaredDeps: Record<string, unknown> | null; status: string } | undefined,
  pluginStep: { output: { skipped: boolean }; status: string } | null = {
    output: { skipped: false },
    status: 'done',
  },
  verificationStep: {
    endedAt: Date;
    output: {
      envTemplateId: string;
      reports: Array<{ id: string; passed: boolean }>;
    };
    status: string;
  } | null = {
    endedAt: new Date('2026-07-15T12:01:00Z'),
    output: {
      envTemplateId: 'env-1',
      reports: [
        { id: 'lsp-intelephense', passed: true },
        { id: 'lsp-vtsls', passed: true },
        { id: 'lsp-pyright', passed: true },
        { id: 'lsp-gopls', passed: true },
        { id: 'lsp-rust-analyzer', passed: true },
        { id: 'lsp-jdtls', passed: true },
      ],
    },
    status: 'done',
  },
): Database {
  let taskStepQuery = 0;
  return {
    query: {
      tasks: {
        findFirst: async () => ({
          envTemplateId: envTemplate ? 'env-1' : null,
          repositoryId: 'repo-1',
        }),
      },
      envTemplates: {
        findFirst: async () =>
          envTemplate
            ? {
                ...envTemplate,
                generatedDockerfile: 'FROM haive-sandbox',
                lastBuiltAt: new Date('2026-07-15T12:00:00Z'),
              }
            : undefined,
      },
      taskSteps: {
        findFirst: async () => {
          taskStepQuery += 1;
          return (taskStepQuery === 1 ? verificationStep : pluginStep) ?? undefined;
        },
      },
      repositories: {
        findFirst: async () => {
          throw new Error('linked environments must not fall back to onboarding');
        },
      },
    },
  } as unknown as Database;
}

describe('parseConfiguredLspLanguages', () => {
  it('preserves every supported server selection and removes duplicates', () => {
    expect(
      parseConfiguredLspLanguages([
        'php-extended',
        'typescript',
        'python',
        'go',
        'rust',
        'java',
        'typescript',
      ]),
    ).toEqual(['php-extended', 'typescript', 'python', 'go', 'rust', 'java']);
  });

  it('distinguishes an explicit empty selection from an absent legacy field', () => {
    expect(parseConfiguredLspLanguages([])).toEqual([]);
    expect(parseConfiguredLspLanguages(undefined)).toBeNull();
  });

  it('drops unknown and server-only values that have no CLI plugin bridge', () => {
    expect(parseConfiguredLspLanguages(['solargraph', 'unknown', 'python'])).toEqual(['python']);
  });

  it('maps every environment server key to its CLI bridge without collapsing languages', () => {
    expect(
      parseConfiguredLspLanguages([
        'intelephense-extended',
        'vtsls',
        'pyright',
        'gopls',
        'rust-analyzer',
        'jdtls',
      ]),
    ).toEqual(['php-extended', 'typescript', 'python', 'go', 'rust', 'java']);
  });

  it('does not claim a bridge for a Solargraph-only environment', () => {
    expect(parseConfiguredLspLanguages(['solargraph'])).toEqual([]);
  });

  it('treats a linked legacy environment with no LSP field as authoritative none', async () => {
    const db = environmentDb({ declaredDeps: {}, status: 'ready' });
    await expect(loadConfiguredLspLanguages(db, 'task-1')).resolves.toEqual([]);
  });

  it('loads all bridged server selections from the linked environment', async () => {
    const db = environmentDb({
      declaredDeps: { lspServers: ['intelephense-extended', 'vtsls', 'pyright', 'gopls'] },
      status: 'pending',
    });
    await expect(loadConfiguredLspLanguages(db, 'task-1')).resolves.toEqual([
      'php-extended',
      'typescript',
      'python',
      'go',
    ]);
  });

  it('advertises runtime LSP only for a ready image with a usable CLI bridge', async () => {
    await expect(
      hasReadyLspBridge(
        environmentDb({ declaredDeps: { lspServers: ['vtsls'] }, status: 'pending' }),
        'task-1',
      ),
    ).resolves.toBe(false);
    await expect(
      hasReadyLspBridge(
        environmentDb({ declaredDeps: { lspServers: ['solargraph'] }, status: 'ready' }),
        'task-1',
      ),
    ).resolves.toBe(false);
    await expect(
      hasReadyLspBridge(
        environmentDb({ declaredDeps: { lspServers: ['vtsls', 'pyright'] }, status: 'ready' }),
        'task-1',
      ),
    ).resolves.toBe(true);
  });

  it('does not advertise a server whose CLI bridge installation is absent or skipped', async () => {
    const readyEnvironment = {
      declaredDeps: { lspServers: ['vtsls'] },
      status: 'ready',
    };
    await expect(
      hasReadyLspBridge(
        environmentDb(readyEnvironment, { output: { skipped: true }, status: 'done' }),
        'task-1',
      ),
    ).resolves.toBe(false);
    await expect(hasReadyLspBridge(environmentDb(readyEnvironment, null), 'task-1')).resolves.toBe(
      false,
    );
  });

  it('requires current successful smoke evidence for every configured bridged server', async () => {
    const readyEnvironment = {
      declaredDeps: { lspServers: ['vtsls', 'pyright'] },
      status: 'ready',
    };
    const verification = (
      reports: Array<{ id: string; passed: boolean }>,
      endedAt = new Date('2026-07-15T12:01:00Z'),
    ) => ({
      endedAt,
      output: { envTemplateId: 'env-1', reports },
      status: 'done',
    });

    await expect(
      hasReadyLspBridge(
        environmentDb(
          readyEnvironment,
          undefined,
          verification([
            { id: 'lsp-vtsls', passed: true },
            { id: 'lsp-pyright', passed: false },
          ]),
        ),
        'task-1',
      ),
    ).resolves.toBe(false);
    await expect(
      hasReadyLspBridge(
        environmentDb(
          readyEnvironment,
          undefined,
          verification([{ id: 'lsp-vtsls', passed: true }]),
        ),
        'task-1',
      ),
    ).resolves.toBe(false);
    await expect(
      hasReadyLspBridge(
        environmentDb(
          readyEnvironment,
          undefined,
          verification(
            [
              { id: 'lsp-vtsls', passed: true },
              { id: 'lsp-pyright', passed: true },
            ],
            new Date('2026-07-15T11:59:00Z'),
          ),
        ),
        'task-1',
      ),
    ).resolves.toBe(false);
    await expect(
      hasReadyLspBridge(environmentDb(readyEnvironment, undefined, null), 'task-1'),
    ).resolves.toBe(false);
  });
});
