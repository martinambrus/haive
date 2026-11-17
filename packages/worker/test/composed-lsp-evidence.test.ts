import { buildLspLayer } from '../src/sandbox/lsp-layer.js';
import { describe, expect, it } from 'vitest';
import { buildSmokeChecks } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
import { hasReadyLspBridge } from '../src/lsp/configured-lsp.js';
import { selectStaleComposedImages } from '../src/sandbox/composed-image-reaper.js';
import type { Database } from '@haive/database';

function legacyReadyDb(contract: unknown): Database {
  return {
    query: {
      tasks: { findFirst: async () => ({ envTemplateId: 'env' }) },
      envTemplates: {
        findFirst: async () => ({
          status: 'ready',
          generatedDockerfile: 'FROM ubuntu:24.04',
          lastBuiltAt: new Date(0),
          declaredDeps: { lspInstallContractVersion: contract, lspServers: ['gopls'] },
        }),
      },
      taskSteps: {
        findFirst: async (q: { columns: Record<string, boolean> }) =>
          q.columns.endedAt
            ? {
                status: 'done',
                endedAt: new Date(1),
                output: { envTemplateId: 'env', reports: [{ id: 'lsp-gopls', passed: true }] },
              }
            : { status: 'done', output: { skipped: false } },
      },
    },
  } as unknown as Database;
}

describe('composed LSP consumer cutover controls', () => {
  it('splits contract-2 environment checks from composed LSP checks', () => {
    expect(
      buildSmokeChecks({
        lspInstallContractVersion: 2,
        runtimes: ['node'],
        lspServers: ['gopls'],
      }).map((x) => x.id),
    ).toEqual(['node', 'bash']);
  });
  it('does not accept legacy reports for contract 2 without matching composed evidence', async () => {
    expect(await hasReadyLspBridge(legacyReadyDb(2), 'task')).toBe(false);
  });
  it.each([0, null, '2', 3])('refuses unknown readiness contract %s', async (contract) => {
    expect(await hasReadyLspBridge(legacyReadyDb(contract), 'task')).toBe(false);
  });
  it.each([undefined, 1])('preserves legacy report reading for %s', async (contract) => {
    expect(await hasReadyLspBridge(legacyReadyDb(contract), 'task')).toBe(true);
  });
  it('keeps reset-safe task references even without a container or step output', () => {
    const images = [{ ref: 'image:old', id: 'sha256:old', createdAtMs: 0 }];
    // Fourth protection source is durable task ownership, separate from container state.
    expect(
      (selectStaleComposedImages as (...args: unknown[]) => string[])(
        images,
        new Set(),
        100,
        10,
        new Set(['sha256:old']),
      ),
    ).toEqual([]);
  });
});

// A skip on a base that already ships the selected server must not inherit its old
// launcher. These are generated-body checks; no host launcher is removed.

describe('skipped installer cannot reuse an inherited launcher', () => {
  it.each(['gopls', 'rust-analyzer', 'solargraph', 'jdtls'])(
    'clears the recipe-owned %s launcher before its skip-capable recipe',
    (server) => {
      const body = buildLspLayer([server]);
      const cleanup = body.indexOf(`RUN rm -f /usr/local/bin/${server}`);
      expect(cleanup).toBeGreaterThan(-1);
      expect(cleanup).toBeLessThan(body.indexOf(`# haive-lsp-recipe: ${server}`));
    },
  );
});
