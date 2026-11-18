import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import {
  GIT_MCP_IMAGE_LABEL,
  GIT_MCP_SERVER_VERSION,
  imageCarriesGitMcp,
} from '../src/sandbox/git-mcp-pin.js';
import { buildDefaultMcpServers, type McpServerSpec } from '../src/sandbox/mcp-config.js';
import {
  composeSandboxImage,
  SANDBOX_CORE_IMAGE,
  type ComposeInput,
} from '../src/sandbox/image-composer.js';
import { buildProviderInstallLines } from '../src/cli-versions/codegen.js';
import { ensureComposedImage } from '../src/sandbox/composed-image-cache.js';
import type { DockerBuildOpts, DockerRunner } from '../src/sandbox/docker-runner.js';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { emptyMcpSurface } from '../src/sandbox/mcp-surface.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: vi.fn(async () => true) }));
vi.mock('../src/sandbox/mcp-surface.js', async (original) => ({
  ...(await original<object>()),
  resolveMcpSurface: vi.fn(async (_db, _task, ragOnly) => ({
    ...emptyMcpSurface(),
    ragOnly,
    rag: { enabled: true, apiUrl: 'http://api.invalid', token: randomBytes(32).toString('hex') },
  })),
}));
vi.mock('../src/sandbox/sandbox-core-image.js', async (original) => ({
  ...(await original<object>()),
  ensureSandboxCoreImage: vi.fn(async () => {}),
}));
const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox-image');
const FILES = ['git-mcp-requirements.txt', 'install-git-mcp.sh'] as const;
const COPY_LINE = 'COPY git-mcp-requirements.txt install-git-mcp.sh /tmp/haive-git-mcp/';
const RUN_LINE = 'RUN sh /tmp/haive-git-mcp/install-git-mcp.sh && rm -rf /tmp/haive-git-mcp';
const INSTALL_SCRIPT = join(IMAGE_DIR, 'install-git-mcp.sh');

/** The mcp-server-git version pinned by the committed lock. */
function lockPinnedVersion(lock: string): string | undefined {
  return /^mcp-server-git==([^\s;\\]+)/m.exec(lock)?.[1];
}
const LOCK_VERSION = lockPinnedVersion(
  readFileSync(join(IMAGE_DIR, 'git-mcp-requirements.txt'), 'utf8'),
);
const LABEL_LINE = `LABEL haive.git-mcp="${LOCK_VERSION}"`;

async function readImageFile(name: string): Promise<Buffer | null> {
  try {
    return await readFile(join(IMAGE_DIR, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** sha256 over name + NUL + bytes + NUL for each file, in FILES order. */
async function contextHash(): Promise<string> {
  const h = createHash('sha256');
  for (const name of FILES) {
    const bytes = await readImageFile(name);
    if (!bytes)
      throw new Error(`sandbox-image/${name} does not exist: the baked git MCP is not in place`);
    h.update(name + '\0')
      .update(bytes)
      .update('\0');
  }
  return h.digest('hex');
}

// ---- pure predicates (each returns a list of violations; empty = holds) ----

function declaredGitViolations(spec: McpServerSpec | undefined): string[] {
  if (!spec) return ['no git server declared'];
  const out: string[] = [];
  if (['uvx', 'uv', 'npx'].includes(spec.command))
    out.push(`git server still fetches at run time via ${spec.command}`);
  if (!/^\/opt\/haive-git-mcp-[^/]+\/venv\/bin\/python$/.test(spec.command))
    out.push(`git command is ${spec.command}, not /opt/haive-git-mcp-<V>/venv/bin/python`);
  const head = spec.args.slice(0, 3).join(' ');
  if (head !== '-I -m mcp_server_git')
    out.push(`git args start with "${head}", not "-I -m mcp_server_git"`);
  return out;
}

function pathVersion(command: string): string | null {
  return /^\/opt\/haive-git-mcp-([^/]+)\/venv\/bin\/python$/.exec(command)?.[1] ?? null;
}

function lockViolations(lock: string | null, declaredCommand: string): string[] {
  if (lock === null) return ['git-mcp-requirements.txt does not exist'];
  const logical = lock
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const pins = logical.filter((l) => /^mcp-server-git==/.test(l));
  const out: string[] = [];
  if (pins.length !== 1) out.push(`lock pins mcp-server-git== ${pins.length} times, expected 1`);
  for (const l of logical)
    if (!/--hash=sha256:[0-9a-f]{64}/.test(l)) out.push(`requirement line without hash: ${l}`);
  const lockV = pins[0] ? /^mcp-server-git==([^\s;]+)/.exec(pins[0])?.[1] : undefined;
  const pathV = pathVersion(declaredCommand);
  if (!lockV || lockV !== pathV)
    out.push(
      `lock version ${lockV ?? 'none'} differs from declared path version ${pathV ?? 'none'}`,
    );
  return out;
}

function layerText(hex: string): string {
  return `# haive-git-mcp-context: sha256:${hex}\n${COPY_LINE}\n${RUN_LINE}\n${LABEL_LINE}`;
}

function layerViolations(body: string, hex: string, laterMarkers: string[]): string[] {
  const layer = layerText(hex);
  const out: string[] = [];
  const count = body.split(layer).length - 1;
  if (count !== 1) out.push(`layer appears ${count} times, expected exactly 1 with hash ${hex}`);
  const at = body.indexOf(layer);
  const runtime = body.indexOf('command -v uvx');
  if (at >= 0 && (runtime < 0 || at < runtime))
    out.push('layer is not after the runtime-tools layer');
  for (const m of laterMarkers) {
    const mi = body.indexOf(m);
    if (mi < 0) out.push(`marker not in body (harness gap): ${m}`);
    else if (at >= 0 && at > mi) out.push(`layer comes after ${m}`);
  }
  return out;
}

function contextViolations(listing: string[]): string[] {
  const out: string[] = [];
  for (const name of ['Dockerfile', ...FILES])
    if (!listing.includes(name)) out.push(`build context lacks ${name}`);
  return out;
}

// ---- K1 ----
const REPO = '/haive/workdir';
const gitSpec = () => buildDefaultMcpServers({ repoPath: REPO }).find((s) => s.name === 'git');

describe('K1 declared git server', () => {
  it('runs the baked venv python with no fetch', () => {
    const v = declaredGitViolations(gitSpec());
    expect(v, v.join('; ')).toEqual([]);
    expect(gitSpec()!.args.slice(-2)).toEqual(['--repository', REPO]);
  });
  it('negative: a uvx entry is flagged', () => {
    const v = declaredGitViolations({
      name: 'git',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', REPO],
    });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(' ')).toContain('uvx');
  });
  it('negative: the baked shape passes', () => {
    expect(
      declaredGitViolations({
        name: 'git',
        command: '/opt/haive-git-mcp-1.2.3/venv/bin/python',
        args: ['-I', '-m', 'mcp_server_git', '--repository', REPO],
      }),
    ).toEqual([]);
  });
});

// ---- K2 ----
const goodLock = `mcp-server-git==1.2.3 \\\n    --hash=sha256:${'a'.repeat(64)} \\\n    --hash=sha256:${'b'.repeat(64)}\nmcp==1.0.0 \\\n    --hash=sha256:${'c'.repeat(64)}\n`;
describe('K2 pinned lock', () => {
  it('the committed lock pins one hashed mcp-server-git matching the declared path', async () => {
    const lock = (await readImageFile('git-mcp-requirements.txt'))?.toString('utf8') ?? null;
    const v = lockViolations(lock, gitSpec()!.command);
    expect(v, v.join('; ')).toEqual([]);
  });
  it('negative: a different version vs the declared path is flagged', () => {
    const v = lockViolations(goodLock, '/opt/haive-git-mcp-9.9.9/venv/bin/python');
    expect(v.join(' ')).toContain('differs from declared path');
  });
  it('negative: matching version, hashed lock passes', () => {
    expect(lockViolations(goodLock, '/opt/haive-git-mcp-1.2.3/venv/bin/python')).toEqual([]);
  });
  it('negative: unhashed line and a double pin are flagged', () => {
    const v = lockViolations(
      `${goodLock}mcp-server-git==1.2.3\nfoo==1\n`,
      '/opt/haive-git-mcp-1.2.3/venv/bin/python',
    );
    expect(v.join(' ')).toContain('without hash');
    expect(v.join(' ')).toContain('2 times');
  });
});

// ---- K3 / K4 ----
const claude = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null as string | null,
};
const codex = { name: 'codex' as const, cliVersion: '1.2.3', sandboxDockerfileExtra: null };
const EXTRA = 'RUN echo haive-extra-marker';
const cases: Array<{ label: string; input: ComposeInput; markers: (i: ComposeInput) => string[] }> =
  [
    {
      label: 'no env template, codex',
      input: { envTemplateDockerfile: null, provider: codex, baseImageId: null },
      markers: () => [],
    },
    {
      label: 'ubuntu env template',
      input: {
        envTemplateDockerfile: 'FROM ubuntu:24.04\nRUN echo ubuntu-body\n',
        provider: claude,
        baseImageId: null,
      },
      markers: () => [],
    },
    {
      label: 'alpine env template',
      input: {
        envTemplateDockerfile: 'FROM alpine:3.20\nRUN echo alpine-body\n',
        provider: claude,
        baseImageId: null,
      },
      markers: () => [],
    },
    {
      label: 'contract 2 with environmentImage and one LSP server',
      input: {
        envTemplateDockerfile: 'FROM ubuntu:24.04\n',
        provider: claude,
        baseImageId: null,
        lspInstallContractVersion: 2,
        lspServers: ['php-extended'],
        lspServerVersions: { php: '1.18.4' },
        environmentImage: { ref: 'haive-env:retained', imageId: 'sha256:' + 'd'.repeat(64) },
      },
      markers: () => ['# haive-lsp-install-contract: 2', 'intelephense'],
    },
    {
      label: 'provider with sandboxDockerfileExtra',
      input: {
        envTemplateDockerfile: null,
        provider: { ...claude, sandboxDockerfileExtra: EXTRA },
        baseImageId: null,
      },
      markers: () => [EXTRA],
    },
  ];

function providerLines(input: ComposeInput): string[] {
  const g = buildProviderInstallLines(input.provider.name, input.provider.cliVersion);
  return g.supported && g.lines.length > 0 ? [g.lines[0]!] : [];
}

describe('K3 composed bodies carry the git MCP layer once, after runtime tools', () => {
  it.each(cases)('$label', async ({ input, markers }) => {
    const hex = await contextHash();
    const body = composeSandboxImage(input).dockerfileBody;
    const v = layerViolations(body, hex, [...markers(input), ...providerLines(input)]);
    expect(v, v.join('; ')).toEqual([]);
  });
  it('negative: layer after the provider install lines is flagged', () => {
    const hex = 'e'.repeat(64);
    const body = `FROM x\n\nRUN command -v uvx\n\nRUN npm i provider\n\n${layerText(hex)}\n`;
    const v = layerViolations(body, hex, ['RUN npm i provider']);
    expect(v.join(' ')).toContain('layer comes after RUN npm i provider');
  });
  it('negative: layer before the runtime layer and a duplicate are flagged', () => {
    const hex = 'e'.repeat(64);
    const body = `FROM x\n\n${layerText(hex)}\n\n${layerText(hex)}\n\nRUN command -v uvx\n`;
    const v = layerViolations(body, hex, []);
    expect(v.join(' ')).toContain('2 times');
    expect(v.join(' ')).toContain('not after the runtime-tools layer');
  });
  it('negative: correct placement passes', () => {
    const hex = 'e'.repeat(64);
    const body = `FROM x\n\nRUN command -v uvx\n\n${layerText(hex)}\n\nRUN npm i provider\n`;
    expect(layerViolations(body, hex, ['RUN npm i provider'])).toEqual([]);
  });
});

describe('K4 core Dockerfile', () => {
  it('carries the same COPY and RUN lines and the version label', async () => {
    const text = (await readFile(join(IMAGE_DIR, 'Dockerfile'), 'utf8')).split('\n');
    const missing = [COPY_LINE, RUN_LINE, LABEL_LINE].filter((l) => !text.includes(l));
    expect(missing, `core Dockerfile lacks: ${missing.join(' | ')}`).toEqual([]);
  });
});

// ---- K5 ----
const provider = { id: 'p', userId: 'u', ...claude };
const ID = 'sha256:core';
const ENV_TAG = 'haive-env:retained';
function database(): Database {
  return {
    query: {
      tasks: {
        findFirst: async () => ({
          envTemplateId: 'env',
          repositoryId: 'repo',
          metadata: undefined,
        }),
      },
      envTemplates: {
        findFirst: async () => ({
          status: 'ready',
          generatedDockerfile: `FROM ${SANDBOX_CORE_IMAGE}\nRUN echo saved-body\n`,
          imageTag: ENV_TAG,
          builtImageId: ID,
          declaredDeps: {
            lspInstallContractVersion: 2,
            lspServers: ['php-extended'],
            lspServerVersions: { php: '1.18.4' },
          },
        }),
      },
      cliProviders: { findFirst: async () => provider },
      repositories: { findFirst: async () => ({ rtkVersion: '0.42.4' }) },
      toolPackageVersions: { findFirst: async () => null },
    },
  } as unknown as Database;
}

describe('K5 composed build context', () => {
  it('holds the Dockerfile and both git MCP files, byte-identical, when build runs', async () => {
    let listing: string[] = [];
    const copies = new Map<string, Buffer | null>();
    const images = new Set([SANDBOX_CORE_IMAGE, ENV_TAG]);
    const runner = fakeDockerRunner({
      inspect: async (ref) => ({ exists: images.has(ref), imageId: ID }),
      build: async (opts: DockerBuildOpts) => {
        images.add(opts.tag);
        listing = await readdir(opts.contextDir);
        for (const name of FILES)
          copies.set(name, await readFile(join(opts.contextDir, name)).catch(() => null));
        return {
          exitCode: 0,
          imageTag: opts.tag,
          imageId: 'sha256:built',
          stdout: '',
          stderr: '',
          timedOut: false,
          durationMs: 1,
        };
      },
    });
    await ensureComposedImage(database(), 't', provider, runner);
    const expected = new Map<string, Buffer>();
    for (const name of FILES) {
      const b = await readImageFile(name);
      if (b) expected.set(name, b);
    }
    const v = contextViolations(listing);
    for (const name of FILES) {
      const want = expected.get(name);
      const got = copies.get(name);
      if (want && got && !want.equals(got)) v.push(`${name} differs from sandbox-image copy`);
    }
    expect(v, `${v.join('; ')} (context listing: ${listing.join(',')})`).toEqual([]);
  });
  it('negative: a listing without the two files is flagged', () => {
    const v = contextViolations(['Dockerfile']);
    expect(v).toEqual([
      'build context lacks git-mcp-requirements.txt',
      'build context lacks install-git-mcp.sh',
    ]);
  });
  it('negative: a full listing passes', () => {
    expect(contextViolations(['Dockerfile', ...FILES])).toEqual([]);
  });
});

// ---- K6 ----
async function mcpServers(image: string | null = null, runner?: DockerRunner) {
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, value) => value!);
  const files = await resolveMcpExtraFiles(
    null as never,
    'task',
    'claude-code',
    REPO,
    image,
    'full',
    false,
    true,
    undefined,
    'repository',
    undefined,
    runner,
  );
  const config = files.files.map((f) => f.content).find((c) => c.includes('"mcpServers"'))!;
  return JSON.parse(config).mcpServers as Record<string, { command: string; args: string[] }>;
}
const asSpec = (e: { command: string; args: string[] } | undefined): McpServerSpec | undefined =>
  e && { name: 'git', command: e.command, args: e.args };

describe('K6 repo-root run keeps the baked git server', () => {
  it('declares servers.git', async () => {
    const servers = await mcpServers();
    const v = declaredGitViolations(asSpec(servers.git));
    expect(v, v.join('; ')).toEqual([]);
  });
  it('negative: a config whose git entry is uvx is flagged', () => {
    expect(
      declaredGitViolations(asSpec({ command: 'uvx', args: ['mcp-server-git'] })).length,
    ).toBeGreaterThan(0);
  });
});

describe('image label gate', () => {
  const labelled = (labels: Record<string, string> | undefined) => ({
    inspect: async () => ({ exists: true, imageId: 'sha256:x', labels }),
  });
  it('the label constant and the lock version feed the layer line', () => {
    expect(`LABEL ${GIT_MCP_IMAGE_LABEL}="${GIT_MCP_SERVER_VERSION}"`).toBe(LABEL_LINE);
  });
  it('the version constant equals the version pinned by the committed lock', () => {
    expect(GIT_MCP_SERVER_VERSION).toBe(LOCK_VERSION);
  });
  it('true when the label equals the baked version', async () => {
    const r = labelled({ [GIT_MCP_IMAGE_LABEL]: GIT_MCP_SERVER_VERSION });
    expect(await imageCarriesGitMcp('img', r)).toBe(true);
  });
  it('false when the label is absent', async () => {
    expect(await imageCarriesGitMcp('img', labelled({}))).toBe(false);
    expect(await imageCarriesGitMcp('img', labelled(undefined))).toBe(false);
  });
  it('false when the label names another version', async () => {
    expect(await imageCarriesGitMcp('img', labelled({ [GIT_MCP_IMAGE_LABEL]: '1.0.0' }))).toBe(
      false,
    );
  });
  it('true when the image is missing locally', async () => {
    const r = { inspect: async () => ({ exists: false, imageId: null }) };
    expect(await imageCarriesGitMcp('img', r)).toBe(true);
  });
  it('true for a null image', async () => {
    const r = {
      inspect: async (): Promise<never> => {
        throw new Error('must not be called');
      },
    };
    expect(await imageCarriesGitMcp(null, r)).toBe(true);
  });
  it('true when inspect rejects', async () => {
    const r = {
      inspect: async (): Promise<never> => {
        throw new Error('docker unavailable');
      },
    };
    expect(await imageCarriesGitMcp('img', r)).toBe(true);
  });
  it('resolveMcpExtraFiles omits git for an image without the label', async () => {
    const runner = fakeDockerRunner(labelled({}));
    const servers = await mcpServers('stale:image', runner);
    expect(servers.git).toBeUndefined();
  });
  it('resolveMcpExtraFiles declares the baked git server for a labelled image', async () => {
    const runner = fakeDockerRunner(labelled({ [GIT_MCP_IMAGE_LABEL]: GIT_MCP_SERVER_VERSION }));
    const servers = await mcpServers('fresh:image', runner);
    const v = declaredGitViolations(asSpec(servers.git));
    expect(v, v.join('; ')).toEqual([]);
  });
});

describe('install-git-mcp.sh', () => {
  const run = (script: string, env?: NodeJS.ProcessEnv) =>
    spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 10_000, env });
  async function stage(lock: string | null): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'git-mcp-script-'));
    tempDirs.push(dir);
    await copyFile(INSTALL_SCRIPT, join(dir, 'install-git-mcp.sh'));
    if (lock === null) await copyFile(join(IMAGE_DIR, FILES[0]), join(dir, FILES[0]));
    else await writeFile(join(dir, FILES[0]), lock);
    return dir;
  }

  it('parses as POSIX sh', () => {
    const r = spawnSync('/bin/sh', ['-n', INSTALL_SCRIPT], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status, r.stderr).toBe(0);
  });
  it('refuses a lock without an mcp-server-git pin', async () => {
    const dir = await stage(`mcp==1.0.0 \\\n    --hash=sha256:${'c'.repeat(64)}\n`);
    const r = run(join(dir, 'install-git-mcp.sh'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not pin mcp-server-git');
  });
  // The stamp check reads /opt/haive-git-mcp-<v>/install.sha256, so a host that has it would skip
  // the install path this case needs to reach.
  it.skipIf(existsSync(`/opt/haive-git-mcp-${LOCK_VERSION}/install.sha256`))(
    'passes the pin check with the real lock and stops at the missing curl',
    async () => {
      const dir = await stage(null);
      // The script itself needs dirname, sed, cat, cut and sha256sum before it looks for curl, so
      // the PATH holds links to exactly those and nothing else.
      const toolPath = await mkdtemp(join(tmpdir(), 'git-mcp-path-'));
      tempDirs.push(toolPath);
      for (const tool of ['dirname', 'sed', 'cat', 'cut', 'sha256sum']) {
        const real = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((f) => existsSync(f));
        if (!real) throw new Error(`${tool} not found on this host`);
        await symlink(real, join(toolPath, tool));
      }
      const r = run(join(dir, 'install-git-mcp.sh'), { PATH: toolPath });
      expect(r.stderr).not.toContain('does not pin mcp-server-git');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('curl is required');
    },
  );
});
