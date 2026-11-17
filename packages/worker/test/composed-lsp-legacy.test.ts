import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ensureComposedImage } from '../src/sandbox/composed-image-cache.js';
import { composeSandboxImage } from '../src/sandbox/image-composer.js';
import { renderDockerfile } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));
const provider = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
};

function database(dockerfile: string): Database {
  return {
    query: {
      tasks: { findFirst: async () => ({ envTemplateId: 'env', repositoryId: null }) },
      envTemplates: {
        findFirst: async () => ({
          status: 'ready',
          generatedDockerfile: dockerfile,
          declaredDeps: {
            lspServers: ['intelephense-extended'],
            lspServerVersions: { 'intelephense-extended': '1.18.4' },
          },
        }),
      },
      toolPackageVersions: { findFirst: async () => null },
    },
  } as unknown as Database;
}

describe('composed LSP additive transition', () => {
  it('retains the legacy template installer and its pin without requiring new metadata', () => {
    const template = renderDockerfile('ubuntu:24.04', {
      lspServers: ['intelephense-extended'],
      lspServerVersions: { 'intelephense-extended': '1.18.4' },
    });
    expect(template).toContain('npm install -g intelephense@1.18.4');
    const result = composeSandboxImage({ envTemplateDockerfile: template, provider });
    expect(result.dockerfileBody).toContain('npm install -g intelephense@1.18.4');
    expect(result.dockerfileBody).toContain('nodejs');
  });

  it('uses the old stored composition as a cache hit with no build or removal', async () => {
    const template = 'FROM ubuntu:24.04\nRUN npm install -g intelephense@1.18.4\n';
    const old = composeSandboxImage({ envTemplateDockerfile: template, provider });
    const runner = fakeDockerRunner({
      inspect: async (ref) => ({ exists: ref === old.tag, imageId: null }),
    });
    await expect(ensureComposedImage(database(template), 'task', provider, runner)).resolves.toBe(
      old.tag,
    );
  });

  it('rejects a failed replacement build and keeps the previous cached image intact', async () => {
    const template = 'FROM ubuntu:24.04\nRUN npm install -g intelephense@1.18.4\n';
    const old = composeSandboxImage({ envTemplateDockerfile: template, provider });
    const images = new Set([old.tag]);
    const attempted: string[] = [];
    const runner = fakeDockerRunner({
      inspect: async (ref) => ({ exists: images.has(ref), imageId: null }),
      build: async (opts) => {
        attempted.push(opts.tag);
        expect(await readFile(opts.dockerfilePath!, 'utf8')).toContain('intelephense@1.18.4');
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'controlled replacement failure',
          imageId: null,
          imageTag: opts.tag,
          timedOut: false,
          durationMs: 1,
        };
      },
      // remove is deliberately left throwing: a failed build must never call it.
    });
    await expect(
      ensureComposedImage(database(template), 'task', { ...provider, cliVersion: '1.2.4' }, runner),
    ).rejects.toThrow('composed image build failed: controlled replacement failure');
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).not.toBe(old.tag);
    expect([...images]).toEqual([old.tag]);
    await expect(ensureComposedImage(database(template), 'task', provider, runner)).resolves.toBe(
      old.tag,
    );
  });
});
