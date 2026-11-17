import { describe, expect, it } from 'vitest';
import { composeSandboxImage, type ComposeInput } from '../src/sandbox/image-composer.js';
import { composeSandboxImage as frozen } from './fixtures/pre-lsp-composer.js';

const base = {
  envTemplateDockerfile: 'FROM ubuntu:24.04\n',
  provider: { name: 'claude-code' as const, cliVersion: '1.2.3', sandboxDockerfileExtra: null },
};
// Unknown persisted JSON must be refused at runtime, including when forced past TS.
const compose = (extra: Record<string, unknown> = {}) =>
  composeSandboxImage({ ...base, ...extra } as ComposeInput);

describe('composed install contract identity', () => {
  it('freezes legacy/custom tags and bodies across representative saved templates and providers', () => {
    for (const envTemplateDockerfile of [
      null,
      'FROM ubuntu:24.04\n',
      'FROM node:22-alpine\nRUN echo custom\n\n',
      'FROM haive-cli-sandbox:latest\nRUN npm install -g intelephense@1.18.4\n',
    ])
      for (const name of ['claude-code', 'zai', 'codex', 'gemini'] as const)
        for (const lspInstallContractVersion of [undefined, 1]) {
          const input = {
            ...base,
            envTemplateDockerfile,
            provider: {
              name,
              cliVersion: '1.2.3',
              sandboxDockerfileExtra: 'RUN echo owner-extra\n',
            },
            baseImageId: 'sha256:frozen-base',
            rtkVersion: '0.42.4',
          };
          expect(
            composeSandboxImage({
              ...input,
              lspInstallContractVersion,
              lspServers: ['php-extended'],
              lspServerVersions: { php: '1.18.4' },
            } as ComposeInput),
          ).toEqual(frozen(input));
        }
  });

  it('selects recipes only under contract 2 and separates even its empty selection', () => {
    const legacy = compose();
    const current = compose({ lspInstallContractVersion: 2, lspServers: ['php'] });
    expect(current.tag).not.toBe(legacy.tag);
    expect(current.dockerfileBody).toContain('npm install -g --prefix /usr/local intelephense');
    expect(compose({ lspInstallContractVersion: 2 }).tag).not.toBe(legacy.tag);
    expect(compose({ lspInstallContractVersion: 2 }).dockerfileBody).toContain(
      '# haive-lsp-install-contract: 2',
    );
  });

  it('canonicalizes aliases, order, duplicates, pins and ignored distributions before hashing', () => {
    const contract = { lspInstallContractVersion: 2 };
    const a = compose({
      ...contract,
      lspServers: ['typescript', 'go', 'php-extended', 'rust', 'java', 'vtsls'],
      lspServerVersions: {
        typescript: '0.3.0',
        go: 'v0.17.1',
        php: '1.18.4',
        rust: 'unsafe;ignored',
        java: {},
      },
    });
    const b = compose({
      ...contract,
      lspServers: ['jdtls', 'rust-analyzer', 'intelephense', 'gopls', 'vtsls'],
      lspServerVersions: { vtsls: '0.3.0', gopls: '0.17.1', intelephense: '1.18.4' },
    });
    expect(a).toEqual(b);
  });

  it('changes identity for each current composition input', () => {
    const input = {
      ...base,
      envTemplateDockerfile: 'FROM haive-cli-sandbox:latest',
      lspInstallContractVersion: 2,
      lspServers: ['php'],
      lspServerVersions: { php: '1.18.4' },
      baseImageId: 'sha256:a',
      rtkVersion: '0.42.4',
    };
    const original = compose(input);
    for (const changed of [
      { lspServers: ['php', 'vtsls'] },
      { lspServerVersions: { php: '1.18.5' } },
      { envTemplateDockerfile: input.envTemplateDockerfile + '\nRUN echo changed' },
      { baseImageId: 'sha256:b' },
      { rtkVersion: '0.42.5' },
      { provider: { ...base.provider, cliVersion: '1.2.4' } },
      { provider: { ...base.provider, sandboxDockerfileExtra: 'RUN echo extra' } },
    ])
      expect(compose({ ...input, ...changed }).tag).not.toBe(original.tag);
  });

  it.each(['claude-code', 'zai', 'ollama', 'muse', 'openrouter'] as const)(
    'accepts the existing Claude-family LSP bridge for %s',
    (name) => {
      expect(
        compose({
          lspInstallContractVersion: 2,
          provider: { ...base.provider, name },
          lspServers: ['php'],
        }).dockerfileBody,
      ).toContain('intelephense');
    },
  );

  it.each([0, null, '1', '2', 3, {}, []])('refuses unknown contract %j by name', (version) => {
    expect(() => compose({ lspInstallContractVersion: version })).toThrow(
      /Unsupported LSP install contract/,
    );
  });
  it.each(['codex', 'gemini', 'amp', 'grok', 'unknown', '__proto__', 'constructor'])(
    'refuses contract 2 for CLI %s even without selected servers',
    (name) => {
      expect(() =>
        compose({ lspInstallContractVersion: 2, provider: { ...base.provider, name } }),
      ).toThrow(new RegExp(`${name}.*LSP`));
    },
  );
});
