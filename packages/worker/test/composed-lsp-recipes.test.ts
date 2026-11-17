import { spawnSync } from 'node:child_process';
import { symlinkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from '../src/sandbox/shell-quote.js';
import { describe, expect, it } from 'vitest';
import { composeSandboxImage } from '../src/sandbox/image-composer.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  generateDockerfileStep,
  renderDockerfile,
} from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { buildSmokeChecks } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';

function compose(server: string, pin?: string) {
  return composeSandboxImage({
    envTemplateDockerfile: 'FROM ubuntu:24.04\n',
    provider: { name: 'claude-code', cliVersion: null, sandboxDockerfileExtra: null },
    lspServers: [server],
    lspServerVersions: pin === undefined ? undefined : { [server]: pin },
  });
}

// Execute only the recipe RUN: the base/tool/provider sections are deliberately excluded.
function recipeRun(body: string, marker: string) {
  const recipe = body.slice(body.indexOf(`# ${marker}\n`) + marker.length + 3);
  const run = recipe.match(/^RUN ([\s\S]*?)(?=\n(?:RUN |ENV |# )|$)/)?.[1];
  expect(run).toBeDefined();
  return run!.replace(/\\\n/g, '\n');
}

describe('additional composed LSP recipes', () => {
  it.each([
    ['go', 'gopls'],
    ['rust', 'rust-analyzer'],
    ['ruby', 'solargraph'],
    ['java', 'jdtls'],
  ])('canonicalizes %s to %s with one install and stable identity', (language, server) => {
    expect(compose(language)).toEqual(compose(server));
    expect(compose(server).dockerfileBody).toContain(`# haive-lsp-recipe: ${server}`);
    expect(compose(server).tag).not.toBe(compose('vtsls').tag);
  });

  it('pins gopls without doubling a v prefix, installs globally and checks Go as the sandbox user', () => {
    const body = compose('gopls', '0.21.0').dockerfileBody;
    expect(body).toContain('golang.org/x/tools/gopls@v0.21.0');
    expect(compose('gopls', 'v0.21.0')).toEqual(compose('gopls', '0.21.0'));
    expect(compose('gopls', '0.21.1').tag).not.toBe(compose('gopls', '0.21.0').tag);
    expect(body).toContain('GOTOOLCHAIN=local GOBIN=/usr/local/bin go install');
    expect(body).toContain('Go >=1.21');
    expect(body).toContain(
      'su -s /bin/sh node -c \'PATH="$1"; export PATH; go version && gopls version\' haive-lsp "$PATH"',
    );
  });

  it('installs rust-analyzer and rust-src with a private stable toolchain and a public wrapper', () => {
    const body = compose('rust-analyzer').dockerfileBody;
    expect(body).toContain('RUSTUP_HOME=/opt/haive-lsp/rust/rustup');
    expect(body).toContain('CARGO_HOME=/opt/haive-lsp/rust/cargo');
    expect(body).toContain('--component rust-analyzer,rust-src');
    expect(body).not.toContain('export RUSTUP_HOME');
    expect(body).toContain('chmod -R a+rX /opt/haive-lsp/rust');
    expect(body).toContain(
      'su -s /bin/sh node -c \'PATH="$1"; export PATH; rust-analyzer --version\' haive-lsp "$PATH"',
    );
    expect(body).not.toContain('/root/.cargo');
  });

  it('installs Solargraph with isolated gems, a sandbox-user launcher, and strict Ruby prerequisites', () => {
    const body = compose('solargraph', '0.57.0').dockerfileBody;
    expect(body).toContain('Ruby >=3.0');
    expect(body).toContain('rubyhdrdir');
    expect(body).toContain('command -v make');
    expect(body).toContain('command -v cc');
    expect(body).toContain('gem install solargraph --version 0.57.0');
    expect(body).toContain('--install-dir /opt/haive-lsp/solargraph');
    expect(body).toContain('GEM_PATH=/opt/haive-lsp/solargraph');
    expect(body).toContain(
      'su -s /bin/sh node -c \'PATH="$1"; export PATH; solargraph --version\' haive-lsp "$PATH"',
    );
    expect(compose('solargraph', '0.57.1').tag).not.toBe(compose('solargraph', '0.57.0').tag);
  });

  it('checks Python and Java 25, installs a readable jdtls tree, and probes help without starting stdio', () => {
    const body = compose('jdtls').dockerfileBody;
    expect(body).toContain('Java >=25');
    expect(body).toContain('Python >=3.9');
    expect(body).toContain('jdt-language-server-latest.tar.gz');
    expect(body).toContain('exec python3 /opt/haive-lsp/jdtls/bin/jdtls');
    expect(body).toContain('chmod -R a+rX /opt/haive-lsp/jdtls');
    expect(body).toContain(
      'su -s /bin/sh node -c \'PATH="$1"; export PATH; jdtls --help\' haive-lsp "$PATH"',
    );
    expect(body).not.toContain('jdtls --version');
  });

  it.each(['gopls', 'rust-analyzer', 'solargraph', 'jdtls'])(
    'skips visibly before installation when %s prerequisites are missing',
    (server) => {
      const body = compose(server).dockerfileBody;
      const result = spawnSync('/bin/sh', ['-c', recipeRun(body, `haive-lsp-recipe: ${server}`)], {
        env: { PATH: '/nonexistent-haive-lsp-test-path' },
        encoding: 'utf8',
        timeout: 1000,
      });
      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain(`# ${server} SKIPPED:`);
      expect(result.stderr).toContain('required');
    },
  );
});

describe('rendered shell and launcher behavior', () => {
  it.each(['gopls', 'rust-analyzer', 'solargraph', 'jdtls'])(
    'renders valid POSIX shell for %s',
    (server) => {
      const result = spawnSync('/bin/sh', ['-n'], {
        input: recipeRun(compose(server).dockerfileBody, `haive-lsp-recipe: ${server}`),
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it.each([21, 25])('enforces the Java floor with optimization enabled (Java %s)', (major) => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-java-'));
    try {
      const home = join(dir, 'jdk');
      mkdirSync(join(home, 'bin'), { recursive: true });
      symlinkSync('/usr/bin/python3', join(dir, 'python3'));
      writeFileSync(join(dir, 'su'), '#!/bin/sh\nexec /bin/sh -c "$5" "$6" "$7"\n', {
        mode: 0o755,
      });
      writeFileSync(
        join(home, 'bin', 'java'),
        `#!/bin/sh\necho 'openjdk version "${major}.0.1"' >&2\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        '/bin/sh',
        ['-c', recipeRun(compose('jdtls').dockerfileBody, 'haive-lsp-recipe: jdtls')],
        {
          env: { PATH: dir, JAVA_HOME: home, PYTHONOPTIMIZE: '1' },
          encoding: 'utf8',
          timeout: 1000,
        },
      );
      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
      // A compatible Java reaches the next missing prerequisite; no download or host write runs.
      expect(result.stderr).toContain(major < 25 ? 'Java >=25 is required' : 'curl is required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['rust-analyzer', 'solargraph', 'jdtls'])(
    'writes a runnable %s launcher that forwards arguments intact',
    (server) => {
      const dir = mkdtempSync(join(tmpdir(), 'lsp-launcher-'));
      try {
        const toolchain = join(dir, 'toolchain');
        mkdirSync(toolchain);
        const wrapper = join(dir, 'wrapper');
        const creation = recipeRun(compose(server).dockerfileBody, `haive-lsp-recipe: ${server}`)
          .split('\n')
          .find(
            (line) =>
              line.trimStart().startsWith("printf '%s") &&
              line.includes(`/usr/local/bin/${server}`),
          );
        expect(creation).toBeDefined();
        const script = creation!.replaceAll(`/usr/local/bin/${server}`, shellQuote(wrapper));
        const made = spawnSync(
          '/bin/sh',
          ['-c', `lsp_rust_bin=${shellQuote(toolchain)}; ${script}`],
          { encoding: 'utf8' },
        );
        expect(made.stderr).toBe('');
        expect(made.status).toBe(0);
        expect(readFileSync(wrapper, 'utf8').split('\n')[0]).toBe('#!/bin/sh');
        const executable =
          server === 'solargraph' ? 'ruby' : server === 'jdtls' ? 'python3' : 'rust-analyzer';
        writeFileSync(join(toolchain, executable), '#!/bin/sh\nprintf \'<%s>\\n\' "$@"\n', {
          mode: 0o755,
        });
        const launched = spawnSync('/bin/sh', [wrapper, 'one two', '--three'], {
          env: { PATH: toolchain },
          encoding: 'utf8',
        });
        expect(launched.stderr).toBe('');
        expect(launched.status).toBe(0);
        expect(launched.stdout).toContain('<one two>\n<--three>\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('environment LSP install-contract field before cutover', () => {
  it('keeps unversioned and explicit environment-contract templates byte identical', () => {
    const deps = { lspServers: ['gopls'], lspServerVersions: { gopls: '0.21.0' } };
    expect(renderDockerfile('ubuntu:24.04', { ...deps, lspInstallContractVersion: 1 })).toBe(
      renderDockerfile('ubuntu:24.04', deps),
    );
    expect(
      buildSmokeChecks({ ...deps, lspInstallContractVersion: 1 } as Parameters<
        typeof buildSmokeChecks
      >[0]),
    ).toEqual(buildSmokeChecks(deps));
  });

  it('refuses future contract metadata before reusing a saved custom Dockerfile', async () => {
    const ctx = {
      taskId: 'task',
      db: {
        query: {
          tasks: { findFirst: async () => ({ envTemplateId: 'env' }) },
          envTemplates: {
            findFirst: async () => ({
              baseImage: 'ubuntu:24.04',
              declaredDeps: { lspInstallContractVersion: 2 },
              generatedDockerfile: 'FROM ubuntu:24.04\nRUN echo custom\n',
            }),
          },
        },
      },
    } as unknown as StepContext;
    await expect(generateDockerfileStep.detect!(ctx)).rejects.toThrow(/LSP install contract/i);
  });

  it.each([2, 3, 0, '1', null])(
    'refuses contract %j until its generation and verification paths are supported',
    (version) => {
      const deps = { lspServers: ['gopls'], lspInstallContractVersion: version };
      expect(() => renderDockerfile('ubuntu:24.04', deps)).toThrow(/LSP install contract/i);
      expect(() => buildSmokeChecks(deps as Parameters<typeof buildSmokeChecks>[0])).toThrow(
        /LSP install contract/i,
      );
    },
  );
});
