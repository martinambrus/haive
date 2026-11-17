import { describe, expect, it, vi } from 'vitest';
import { renderDockerfile } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { composeSandboxImage } from '../src/sandbox/image-composer.js';
import { buildProviderInstallLines } from '../src/cli-versions/codegen.js';
import { buildDefaultMcpServers } from '../src/sandbox/mcp-config.js';
import fixtures from './fixtures/version-token-baseline.json' with { type: 'json' };
import type { CliProviderName } from '@haive/shared';
// Freeze installation naming only; the fixture was rendered in the default namespace.
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  imageRepo: (suffix: string) => `haive-${suffix}`,
}));
const HOSTILE = [
  '1.2.3\nRUN id',
  '$(id)',
  '`id`',
  '1.2.3;id',
  '"1.2.3"',
  "'1.2.3'",
  '-latest',
  '1 2',
  '1\0x',
  '１.2.3',
  '1.2.3\n',
  ' 1.2.3',
  '1.2.3\u2028',
  'a'.repeat(65),
];
describe('stored version render boundaries', () => {
  const consumers: [string, (token: string) => unknown][] = [
    ...['intelephense', 'intelephense-extended', 'vtsls', 'pyright', 'gopls', 'solargraph'].map(
      (lsp): [string, (token: string) => unknown] => [
        lsp,
        (token) =>
          renderDockerfile('ubuntu:24.04', {
            lspServers: [lsp],
            lspServerVersions: { [lsp]: token },
          }),
      ],
    ),
    [
      'RTK',
      (token) =>
        composeSandboxImage({
          envTemplateDockerfile: null,
          provider: { name: 'codex', cliVersion: null, sandboxDockerfileExtra: null },
          rtkVersion: token,
        }),
    ],
    ...(['codex', 'zai', 'grok'] as const).map((name): [string, (token: string) => unknown] => [
      name,
      (token) => buildProviderInstallLines(name, token),
    ]),
    ...['chrome', 'edge'].map((type): [string, (token: string) => unknown] => [
      type,
      (token) =>
        renderDockerfile('ubuntu:24.04', {
          browserTesting: true,
          browser: { type, version: token },
        }),
    ]),
    [
      'chrome-devtools image',
      (token) =>
        renderDockerfile('ubuntu:24.04', { browserTesting: true, chromeDevtoolsMcpVersion: token }),
    ],
    [
      'chrome-devtools MCP',
      (token) =>
        buildDefaultMcpServers({
          repoPath: '/w',
          includeChromeDevtools: true,
          chromeDevtoolsMcpVersion: token,
        }),
    ],
    ['extra package', (token) => renderDockerfile('ubuntu:24.04', { extraPackages: [token] })],
    ['database', (token) => renderDockerfile('ubuntu:24.04', { database: { kind: token } })],
    ['base image', (token) => renderDockerfile(token, {})],
    [
      'dependency language',
      (token) =>
        renderDockerfile('ubuntu:24.04', {
          preinstallDeps: true,
          packageManagers: { [token]: 'npm' },
        }),
    ],
    [
      'package manager',
      (token) =>
        renderDockerfile('ubuntu:24.04', {
          preinstallDeps: true,
          packageManagers: { node: token },
        }),
    ],
    ...['node', 'php', 'python', 'go', 'rust', 'ruby', 'java'].map(
      (runtime): [string, (token: string) => unknown] => [
        runtime,
        (token) =>
          renderDockerfile('ubuntu:24.04', { runtimes: [runtime], versions: { [runtime]: token } }),
      ],
    ),
  ];
  for (const [label, render] of consumers) {
    it.each(HOSTILE)(`${label} refuses %j before producing text`, (token) => {
      expect(() => render(token)).toThrow(/version|token/i);
    });
  }
  it('matches origin/main renderer bytes for valid pins', () => {
    for (const f of fixtures.environments) expect(renderDockerfile(f.base, f.deps)).toBe(f.output);
    for (const f of fixtures.compositions)
      expect(composeSandboxImage(f.input as Parameters<typeof composeSandboxImage>[0])).toEqual(
        f.output,
      );
    for (const f of fixtures.providers)
      expect(buildProviderInstallLines(f.name as CliProviderName, f.version)).toEqual(f.output);
  });
});
