import { describe, expect, it } from 'vitest';
import { buildProviderInstallLines } from '../src/cli-versions/codegen.js';

/** The `curl -fsSL ... | ... bash ...` line for a curl-script provider. */
function curlLine(name: 'antigravity' | 'grok', version: string | null): string {
  const { lines } = buildProviderInstallLines(name, version);
  const line = lines.find((l) => l.includes('curl -fsSL'));
  expect(line, `${name} emitted no curl install line`).toBeDefined();
  return line!;
}

describe('curl-script install codegen', () => {
  // REGRESSION GUARD. `--dir /usr/local/bin` used to be hardcoded in codegen; it moved into
  // install-metadata as `installArgs` so grok could steer its own installer with an env var
  // instead. antigravity is the only pre-existing user of that branch, so if this line drifts
  // by even a byte, the refactor silently changed where an existing CLI installs.
  it('renders antigravity exactly as before the InstallSpec refactor', () => {
    expect(curlLine('antigravity', null)).toBe(
      'RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin',
    );
  });

  it('does not append a version to antigravity (versionPinnable: false)', () => {
    // Even when a version is on hand: its installer is a manifest downloader with no version
    // argument, so passing one would be sent to a script that cannot honour it.
    expect(curlLine('antigravity', '1.2.3')).toBe(curlLine('antigravity', null));
  });

  it('steers grok with env vars rather than a --dir flag', () => {
    // grok validates $1 as a version and exits "Invalid version format" on a flag, so --dir
    // would break the image build outright.
    const line = curlLine('grok', null);
    expect(line).toBe(
      'RUN curl -fsSL https://x.ai/cli/install.sh | HOME=/opt/grok GROK_BIN_DIR=/usr/local/bin bash -s',
    );
    expect(line).not.toContain('--dir');
  });

  it('sets HOME so the payload is reachable by the sandbox user', () => {
    // REGRESSION GUARD for a shipped break. GROK_BIN_DIR alone only relocates the symlink;
    // DOWNLOAD_DIR is hardcoded to "$HOME/.grok/downloads". Without HOME the real binary sits
    // under root's 0700 home and the image is dead for the non-root `node` user the sandbox
    // runs as (`Cannot find module '/grok'`), while still passing every root-only smoke test.
    expect(curlLine('grok', null)).toContain('HOME=/opt/grok');
  });

  it('passes a pinned grok version as the installer positional', () => {
    expect(curlLine('grok', '1.0.3')).toBe(
      'RUN curl -fsSL https://x.ai/cli/install.sh | HOME=/opt/grok GROK_BIN_DIR=/usr/local/bin bash -s -- 1.0.3',
    );
  });

  it('disables grok auto-update via config file (it has no env knob)', () => {
    const { lines, supported } = buildProviderInstallLines('grok', null);
    expect(supported).toBe(true);
    const joined = lines.join('\n');
    expect(joined).toContain('auto_update = false');
    expect(joined).toContain('/root/.grok/config.toml');
  });
});

describe('config-file auto-update codegen', () => {
  // THE INVARIANT, and the one that actually failed in production: a Dockerfile instruction is
  // ONE physical line. The original emitter interpolated the config content raw, so grok's
  // two-line TOML split the RUN and docker parsed line 2 as an instruction —
  // `dockerfile parse error: unknown instruction: auto_update`. Asserting the general property
  // rather than grok's specific string means the next multi-line config cannot reintroduce it.
  it('never emits a line containing a newline, for any provider', () => {
    const providers = ['claude-code', 'codex', 'gemini', 'amp', 'antigravity', 'grok'] as const;
    for (const name of providers) {
      for (const version of [null, '9.9.9']) {
        for (const line of buildProviderInstallLines(name, version).lines) {
          expect(line, `${name} emitted a multi-line Dockerfile instruction`).not.toContain('\n');
        }
      }
    }
  });

  it('renders grok multi-line TOML as one RUN with an arg per line', () => {
    // `printf '%s\n'` repeats its format per operand, so two args produce two file lines.
    const line = buildProviderInstallLines('grok', null).lines.find((l) => l.includes('printf'));
    expect(line).toBe(
      "RUN mkdir -p /root/.grok && printf '%s\\n' '[cli]' 'auto_update = false' > /root/.grok/config.toml",
    );
  });

  it('leaves codex single-line content byte-identical', () => {
    // The compatibility half of the fix: one arg in, one arg out, exactly as before.
    const line = buildProviderInstallLines('codex', null).lines.find((l) => l.includes('printf'));
    expect(line).toBe(
      "RUN mkdir -p /root/.codex && printf '%s\\n' 'check_for_update_on_startup = false' > /root/.codex/config.toml",
    );
  });
});
