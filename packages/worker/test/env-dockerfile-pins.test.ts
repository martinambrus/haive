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

  // Ubuntu ships no chromium deb: `chromium` has no candidate and `chromium-browser` is a
  // snap redirect stub. The generated image previously named the Debian package on both
  // bases, so /usr/bin/chromium -- which mcp-config, CHROME_PATH, browser-check.js and
  // 08a-browser-verify all assume -- simply did not exist on Ubuntu.
  it('takes the browser from Google apt on Ubuntu and from the chromium deb on Debian', () => {
    const ubuntu = renderDockerfile('ubuntu:24.04', { browserTesting: true });
    expect(ubuntu).toContain('google-chrome-stable');
    expect(ubuntu).toContain('ln -sf /usr/bin/google-chrome /usr/bin/chromium');
    // The Debian package name must NOT be requested on Ubuntu -- that is the original bug.
    expect(ubuntu).not.toMatch(/--no-install-recommends chromium /);

    const debian = renderDockerfile('debian:bookworm-slim', { browserTesting: true });
    expect(debian).toMatch(/--no-install-recommends chromium /);
    expect(debian).not.toContain('google-chrome-stable');
    expect(debian).not.toContain('dl.google.com');
  });

  // Each apt block deletes /var/lib/apt/lists, so every additional block re-fetches the
  // whole package index -- MEASURED 32.3 MB per `apt-get update`. Installing the browser
  // and the X stack from one block is what keeps that off a slow connection.
  it('installs the Ubuntu browser and the X stack from a single apt block', () => {
    const ubuntu = renderDockerfile('ubuntu:24.04', { browserTesting: true });
    const line = ubuntu
      .split('\n')
      .find((l) => l.includes('google-chrome-stable') && l.includes('apt-get install'));
    expect(line).toBeDefined();
    // Same install line, therefore the same `apt-get update`.
    for (const pkg of ['xvfb', 'x11vnc', 'socat', 'procps', 'fonts-dejavu']) {
      expect(line).toContain(pkg);
    }
    // The repo is added inside that block too, not as a separate updating step.
    const browserSection = ubuntu.slice(ubuntu.indexOf('# Browser testing'));
    expect(browserSection.match(/apt-get update/g)?.length).toBe(1);
  });

  it('fails the build when the base cannot produce a working browser', () => {
    // The whole class of bug this guards: an image that builds fine and only reveals it has
    // no browser hours later, inside an MCP tool call during a verification step.
    for (const base of ['ubuntu:24.04', 'debian:bookworm-slim']) {
      expect(renderDockerfile(base, { browserTesting: true })).toContain(
        'RUN /usr/bin/chromium --version',
      );
    }
    // Not emitted at all when browser testing is off -- there is no browser to assert on.
    expect(renderDockerfile('ubuntu:24.04', {})).not.toContain('/usr/bin/chromium --version');
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
