import { describe, expect, it } from 'vitest';
import { renderDockerfile } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { buildDefaultMcpServers } from '../src/sandbox/mcp-config.js';

describe('renderDockerfile LSP version pins', () => {
  it('pins each pinnable LSP install line when versions are provided', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      lspServers: ['intelephense', 'vtsls', 'pyright', 'gopls', 'solargraph', 'rust-analyzer'],
      lspServerVersions: {
        intelephense: '1.18.4',
        vtsls: '0.3.0',
        pyright: '1.1.410',
        gopls: '0.22.0',
        solargraph: '0.59.2',
        'rust-analyzer': '9.9.9',
      },
    });
    expect(df).toContain('npm install -g intelephense@1.18.4');
    expect(df).toContain('npm install -g @vtsls/language-server@0.3.0 typescript');
    expect(df).toContain('pip install --break-system-packages pyright==1.1.410');
    expect(df).toContain('go install golang.org/x/tools/gopls@v0.22.0');
    expect(df).toContain('gem install solargraph -v 0.59.2');
    // rust-analyzer is not pinnable — the version is ignored.
    expect(df).toContain('rustup component add rust-analyzer');
    expect(df).not.toContain('rust-analyzer@9.9.9');
  });

  it('leaves install lines unpinned when no versions are provided', () => {
    const df = renderDockerfile('ubuntu:24.04', { lspServers: ['intelephense', 'gopls'] });
    expect(df).toContain('npm install -g intelephense\n');
    expect(df).toContain('go install golang.org/x/tools/gopls@latest');
    expect(df).not.toContain('intelephense@');
  });

  it('pins the chrome-devtools-mcp env install line when browserTesting is on', () => {
    const pinned = renderDockerfile('ubuntu:24.04', {
      browserTesting: true,
      chromeDevtoolsMcpVersion: '1.2.0',
    });
    expect(pinned).toContain('npm install -g chrome-devtools-mcp@1.2.0');

    const unpinned = renderDockerfile('ubuntu:24.04', { browserTesting: true });
    expect(unpinned).toContain('npm install -g chrome-devtools-mcp');
    expect(unpinned).not.toContain('chrome-devtools-mcp@');
  });
});

describe('buildDefaultMcpServers chrome-devtools version', () => {
  function chromeArgs(opts: Parameters<typeof buildDefaultMcpServers>[0]): string[] {
    const server = buildDefaultMcpServers(opts).find((s) => s.name === 'chrome-devtools');
    return server?.args ?? [];
  }

  it('uses the pinned version in the npx spec', () => {
    const args = chromeArgs({
      repoPath: '/w',
      includeChromeDevtools: true,
      chromeDevtoolsMcpVersion: '1.2.0',
    });
    expect(args).toContain('chrome-devtools-mcp@1.2.0');
    expect(args).not.toContain('chrome-devtools-mcp@latest');
  });

  it('falls back to @latest when unpinned', () => {
    const args = chromeArgs({ repoPath: '/w', includeChromeDevtools: true });
    expect(args).toContain('chrome-devtools-mcp@latest');
  });

  it('keeps the pin when co-driving a live browser URL', () => {
    const args = chromeArgs({
      repoPath: '/w',
      includeChromeDevtools: true,
      chromeDevtoolsBrowserUrl: 'http://127.0.0.1:9222',
      chromeDevtoolsMcpVersion: '1.2.0',
    });
    expect(args).toContain('chrome-devtools-mcp@1.2.0');
    expect(args).toContain('--browser-url=http://127.0.0.1:9222');
  });
});
