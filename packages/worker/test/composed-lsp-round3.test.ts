import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeSandboxImage } from '../src/sandbox/image-composer.js';
import { shellQuote } from '../src/sandbox/shell-quote.js';

function body(server: string, pin?: string) {
  return composeSandboxImage({
    lspInstallContractVersion: 2,
    envTemplateDockerfile: 'FROM ubuntu:24.04\n',
    provider: { name: 'claude-code', cliVersion: null, sandboxDockerfileExtra: null },
    lspServers: [server],
    lspServerVersions: pin === undefined ? undefined : { [server]: pin },
  }).dockerfileBody;
}
function runs(dockerfile: string) {
  return dockerfile
    .replace(/\\\n/g, '\n')
    .split(/\n(?=\S)/)
    .filter((s) => s.startsWith('RUN '))
    .map((s) => s.slice(4));
}
function native(server: string) {
  return runs(body(server).split(`# haive-lsp-recipe: ${server}\n`)[1]!)[0]!;
}
function withPath(check: (dir: string, stub: (name: string, script?: string) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-round3-'));
  try {
    check(dir, (name, script = 'exit 0') =>
      writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function execute(script: string, dir: string) {
  return spawnSync('/bin/sh', ['-c', script], {
    env: { PATH: dir, TEST_DIR: dir },
    encoding: 'utf8',
    timeout: 2000,
  });
}

describe('round 3 composed LSP regressions', () => {
  it('ensures node on a composed Ubuntu body before the first su (no host account writes)', () => {
    withPath((dir, stub) => {
      for (const name of ['uvx', 'rg', 'nano', 'tmux', 'rtk', 'npm', 'groupmod']) stub(name);
      symlinkSync(process.execPath, join(dir, 'node'));
      symlinkSync('/usr/bin/sed', join(dir, 'sed'));
      stub('id', '[ "$2" = ubuntu ] && exit 0\n[ "$2" = node ] && [ -f "$TEST_DIR/node-ready" ]');
      stub('usermod', ': > "$TEST_DIR/node-ready"');
      stub('go', 'echo go1.23.0');
      stub('su', 'id -u node || exit 44\necho node-exists-before-su');
      const commands = runs(body('gopls'));
      const firstSu = commands.findIndex((command) => command.includes('su -s /bin/sh node'));
      expect(firstSu).toBeGreaterThan(0);
      // Docker starts a separate shell for every RUN (the tools RUN exits early).
      for (const command of commands.slice(0, firstSu)) {
        const result = execute(command, dir);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
      expect(execute('id -u node', dir).status).toBe(0);
      const result = execute(commands[firstSu]!.split('GOTOOLCHAIN=local GOBIN=')[0]!, dir);
      expect(result.stdout).toContain('node-exists-before-su');
      expect(result.status).toBe(0);
    });
  });

  it('restores the image PATH even when su resets it', () => {
    withPath((dir, stub) => {
      symlinkSync('/usr/bin/sed', join(dir, 'sed'));
      stub('go', 'echo go1.23.0');
      stub('su', 'PATH=/nonexistent; export PATH\nexec /bin/sh -c "$5" "$6" "$7"');
      // Stop before go install: no download and no writes to global paths.
      const result = execute(native('gopls').split('GOTOOLCHAIN=local GOBIN=')[0]!, dir);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('go1.23.0');
    });
  });

  it('never hands su an argument it could parse as an option, even for a PATH starting with -', () => {
    withPath((dir, stub) => {
      symlinkSync('/usr/bin/sed', join(dir, 'sed'));
      stub('go', 'echo go1.23.0');
      // util-linux su permutes options, so any argument starting with - after the user is read as one.
      stub(
        'su',
        'for a in "$5" "$6" "$7"; do case "$a" in -*) echo "option-like: $a" >&2; exit 64;; esac; done\n' +
          'PATH=/nonexistent; export PATH\nexec /bin/sh -c "$5" "$6" "$7"',
      );
      const recipe = native('gopls').split('GOTOOLCHAIN=local GOBIN=')[0]!;
      const result = execute(`PATH="-z:$PATH"; export PATH; ${recipe}`, dir);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('go1.23.0');
    });
  });

  it('keeps Cargo caches user-owned and leaves rustup context unset in the direct-binary wrapper', () => {
    withPath((dir, stub) => {
      const creation = native('rust-analyzer')
        .split('\n')
        .find(
          (line) =>
            line.trimStart().startsWith("printf '%s") &&
            line.includes('/usr/local/bin/rust-analyzer'),
        )!;
      const wrapper = join(dir, 'wrapper');
      const made = execute(
        `lsp_rust_bin=${shellQuote(dir)}; ${creation.replaceAll('/usr/local/bin/rust-analyzer', shellQuote(wrapper))}`,
        dir,
      );
      expect(made.status).toBe(0);
      stub(
        'rust-analyzer',
        'printf "%s|%s|%s\\n" "${CARGO_HOME-unset}" "${RUSTUP_HOME-unset}" "${RUSTUP_TOOLCHAIN-unset}"',
      );
      const result = execute(`/bin/sh ${shellQuote(wrapper)}`, dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('unset|unset|unset\n');
      expect(readFileSync(wrapper, 'utf8')).not.toContain('CARGO_HOME');
      const userCache = join(dir, 'user-cache');
      const inherited = spawnSync('/bin/sh', [wrapper], {
        env: { PATH: dir, CARGO_HOME: userCache },
        encoding: 'utf8',
      });
      expect(inherited.status).toBe(0);
      expect(inherited.stdout).toBe(`${userCache}|unset|unset\n`);
    });
  });

  it.each(['rust-analyzer', 'jdtls'])(
    'ignores every %s pin before validation or hashing',
    (server) => {
      for (const pin of ['1.2.3', 'latest', '1.2.3\nRUN id', '$(id)'])
        expect(body(server, pin)).toBe(body(server));
    },
  );

  it.each(['gopls', 'solargraph'])('accepts the legacy safe token domain for %s', (server) => {
    for (const pin of ['0.57', 'latest', 'next', '0.57.0.rc1'])
      expect(() => body(server, pin)).not.toThrow();
    for (const pin of ['$(id)', '0.57\n', '-latest'])
      expect(() => body(server, pin)).toThrow(/version token/i);
  });

  it.each(['gopls', 'rust-analyzer', 'solargraph', 'jdtls'])(
    'skips missing %s prerequisites visibly without failing the image',
    (server) => {
      const result = execute(native(server), '/nonexistent-haive-test-path');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`# ${server} SKIPPED:`);
    },
  );

  it('uses the measured Ruby 3.0 floor and skips Ruby 2.7 before installation', () => {
    withPath((dir, stub) => {
      // Execute the generated floor program with a tiny interpreter seam: only 3.0 succeeds.
      stub(
        'ruby',
        'case "$2" in *\'Gem::Version.new("3.0")\'*) [ "$TEST_RUBY" = 3.0 ];; *) exit 82;; esac',
      );
      const script = native('solargraph');
      for (const version of ['2.7', '3.0']) {
        const result = spawnSync('/bin/sh', ['-c', script], {
          env: { PATH: dir, TEST_RUBY: version },
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('# solargraph SKIPPED:');
        expect(result.stderr).toContain(version === '2.7' ? 'Ruby >=3.0' : 'RubyGems');
      }
    });
  });

  it('skips Go below the recipe floor before any installation', () => {
    withPath((dir, stub) => {
      symlinkSync('/usr/bin/sed', join(dir, 'sed'));
      stub('go', 'echo go1.20.14');
      const result = execute(native('gopls'), dir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('# gopls SKIPPED: Go >=1.21');
    });
  });

  it('executes the Node supply block without a package manager', () => {
    const supply = runs(body('intelephense'))[1]!;
    const result = execute(supply, '/nonexistent-haive-test-path');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js and npm are required; no supported package manager');
  });

  it('executes NodeSource on apt for old Node and still enforces Node >=20', () => {
    withPath((dir, stub) => {
      stub(
        'node',
        'case "$2" in *console.error*) echo "LSP layer: Node.js >=20 is required" >&2;; esac\nexit 1',
      );
      for (const name of ['npm', 'apt-get', 'curl', 'bash', 'rm'])
        stub(name, `printf '%s\\n' '${name}' "$@" >> "$TEST_DIR/calls"`);
      const result = execute(runs(body('intelephense'))[1]!, dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Node.js >=20 is required');
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      expect(calls).toContain('https://deb.nodesource.com/setup_22.x');
      expect(calls).toContain('bash\n/tmp/haive-lsp-nodesource.sh');
      expect(calls).toContain('nodejs');
      expect(calls).not.toContain('npm\n--version');
    });
  });
});

describe('gopls pin canonicalization', () => {
  it('treats a bare v pin as unpinned, whatever the key order', async () => {
    const { normalizeLspSelection } = await import('../src/sandbox/lsp-layer.js');
    const unpinned = normalizeLspSelection(['gopls'], {});
    expect(normalizeLspSelection(['gopls'], { gopls: 'v' })).toEqual(unpinned);
    expect(normalizeLspSelection(['gopls'], { go: 'v', gopls: '1.2.3' })).toEqual(
      normalizeLspSelection(['gopls'], { gopls: '1.2.3', go: 'v' }),
    );
  });
});
