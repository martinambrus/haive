import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repo/credentials.js', () => ({
  getDecryptedCredentials: async () => ({
    username: 'haive-user',
    secret: 'haive-pass',
    host: 'x',
  }),
}));

import { gitRun } from '../src/repo/git-exec.js';
import { buildCredentialHelper } from '../src/repo/git-push.js';

const run = promisify(execFile);

const SCRUBBED = [
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EDITOR',
  'GIT_ALLOW_PROTOCOL',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
];

interface Fixture {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  marks: string;
  mark: string;
}

interface Ctx {
  dir: string;
  repo: string;
  bare: string;
  alt: string;
  marks: string;
  g: (...args: string[]) => Promise<string>;
  cfg: (key: string, value: string) => Promise<string>;
  script: (name: string, tail?: string) => Promise<string>;
}

interface Served {
  server: http.Server;
  port: number;
}

const saved: Record<string, string | undefined> = {};
const servers: http.Server[] = [];
let root = '';
let hermetic: Record<string, string> = {};
let tplBase = '';
let tplGc = '';
let srv401: Served;
let srv407: Served;
let seq = 0;

function listen(handler: http.RequestListener): Promise<Served> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function challenge(status: number, header: string): http.RequestListener {
  return (_req, res) => {
    res.writeHead(status, { [header]: 'Basic realm="haive-256"', 'Content-Length': '0' });
    res.end();
  };
}

function smartServer(bare: string, auth: { user: string; pass: string }): Promise<Served> {
  const want = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
  return listen(async (req, res) => {
    if (req.headers.authorization !== want) {
      challenge(401, 'WWW-Authenticate')(req, res);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const proto = String(req.headers['git-protocol'] ?? '');
    const env = { ...process.env, ...hermetic, GIT_PROTOCOL: proto };
    if (req.method === 'GET' && url.pathname.endsWith('/info/refs')) {
      const r = await run('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare], {
        env,
        encoding: 'buffer',
        maxBuffer: 1 << 26,
      });
      const pre = proto.includes('version=2')
        ? Buffer.alloc(0)
        : Buffer.from('001e# service=git-upload-pack\n0000');
      res.writeHead(200, {
        'Content-Type': 'application/x-git-upload-pack-advertisement',
        'Cache-Control': 'no-cache',
      });
      res.end(Buffer.concat([pre, r.stdout]));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/git-upload-pack')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: Buffer = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      const child = spawn('git', ['upload-pack', '--stateless-rpc', bare], { env });
      const out: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stdin.end(body);
      child.on('close', () => {
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
        res.end(Buffer.concat(out));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const gitAt =
  (cwd: string) =>
  async (...args: string[]): Promise<string> =>
    (
      await run('git', args, {
        cwd,
        env: { ...process.env, ...hermetic },
        maxBuffer: 1 << 26,
      })
    ).stdout;

async function writeFile(file: string, body: string): Promise<void> {
  await fs.writeFile(file, body);
}

const ARMOR = {
  openpgp: ['-----BEGIN PGP SIGNATURE-----', '-----END PGP SIGNATURE-----'],
  x509: ['-----BEGIN SIGNED MESSAGE-----', '-----END SIGNED MESSAGE-----'],
  ssh: ['-----BEGIN SSH SIGNATURE-----', '-----END SSH SIGNATURE-----'],
} as const;

async function signedBranch(
  dir: string,
  g: (...args: string[]) => Promise<string>,
  kind: keyof typeof ARMOR,
): Promise<void> {
  const tree = (await g('rev-parse', 'HEAD^{tree}')).trim();
  const parent = (await g('rev-parse', 'HEAD')).trim();
  const [begin, end] = ARMOR[kind];
  const body =
    `tree ${tree}\nparent ${parent}\nauthor n <n@x> 1700000000 +0000\ncommitter n <n@x> 1700000000 +0000\n` +
    `gpgsig ${begin}\n \n abc\n ${end}\n\nsigned\n`;
  const file = path.join(dir, `signed-${kind}.commit`);
  await writeFile(file, body);
  const sha = (await g('hash-object', '-t', 'commit', '-w', file)).trim();
  await g('update-ref', `refs/heads/${kind === 'openpgp' ? 'signed' : `signed-${kind}`}`, sha);
}

async function buildRepo(dir: string, name: string): Promise<(...a: string[]) => Promise<string>> {
  const repo = path.join(dir, name);
  await fs.mkdir(repo, { recursive: true });
  const g = gitAt(repo);
  await g('init', '-q', '-b', 'main');
  await g('config', 'gc.auto', '0');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await g('add', '-A');
  await g('commit', '-q', '-m', 'c1');
  await writeFile(path.join(repo, 'a.txt'), 'two\n');
  await g('add', '-A');
  await g('commit', '-q', '-m', 'c2');
  return g;
}

async function buildTemplates(): Promise<void> {
  tplBase = path.join(root, 'tpl-base');
  await fs.mkdir(tplBase);
  const g = await buildRepo(tplBase, 'repo');
  const repo = path.join(tplBase, 'repo');
  await signedBranch(tplBase, g, 'openpgp');
  await signedBranch(tplBase, g, 'x509');
  await signedBranch(tplBase, g, 'ssh');
  await run('git', ['clone', '-q', '--bare', repo, path.join(tplBase, 'bare.git')], {
    env: { ...process.env, ...hermetic },
  });
  await run('git', ['clone', '-q', '--bare', repo, path.join(tplBase, 'alt.git')], {
    env: { ...process.env, ...hermetic },
  });

  tplGc = path.join(root, 'tpl-gc');
  await fs.mkdir(tplGc);
  const gg = await buildRepo(tplGc, 'repo');
  const gcRepo = path.join(tplGc, 'repo');
  const bare = path.join(tplGc, 'bare.git');
  await run('git', ['clone', '-q', '--bare', gcRepo, bare], {
    env: { ...process.env, ...hermetic },
  });
  await gg('remote', 'add', 'origin', bare);
  await gg('checkout', '-q', '-b', 'doomed');
  await writeFile(path.join(gcRepo, 'a.txt'), 'doomed\n');
  await gg('add', '-A');
  await gg('commit', '-q', '-m', 'doomed');
  await gg('checkout', '-q', 'main');
  await gg('branch', '-D', 'doomed');
  await gg('reflog', 'expire', '--expire=now', '--all');
  await gg('repack', '-q', '-d');
  await writeFile(path.join(gcRepo, 'a.txt'), 'second pack\n');
  await gg('add', '-A');
  await gg('commit', '-q', '-m', 'more');
  await gg('repack', '-q', '-d');
  const past = new Date(Date.now() - 30 * 86400_000);
  const entries = await fs.readdir(path.join(gcRepo, '.git', 'objects'), {
    recursive: true,
    withFileTypes: true,
  });
  for (const e of entries) {
    if (e.isFile()) await fs.utimes(path.join(e.parentPath, e.name), past, past);
  }
  await gg('config', '--local', '--unset', 'gc.auto');
  const other = path.join(tplGc, 'other-clone');
  await run('git', ['clone', '-q', bare, other], { env: { ...process.env, ...hermetic } });
  const og = gitAt(other);
  await writeFile(path.join(other, 'n.txt'), 'n\n');
  await og('add', '-A');
  await og('commit', '-q', '-m', 'n');
  await og('push', '-q', 'origin', 'HEAD:refs/heads/news');
  await fs.rm(other, { recursive: true, force: true, maxRetries: 5 });
}

async function fresh(kind: 'base' | 'gc' = 'base'): Promise<Ctx> {
  const dir = path.join(root, `s${++seq}`);
  await fs.cp(kind === 'base' ? tplBase : tplGc, dir, {
    recursive: true,
    preserveTimestamps: true,
  });
  const marks = path.join(dir, 'marks');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(marks);
  await fs.mkdir(bin);
  const repo = path.join(dir, 'repo');
  const g = gitAt(repo);
  return {
    dir,
    repo,
    bare: path.join(dir, 'bare.git'),
    alt: path.join(dir, 'alt.git'),
    marks,
    g,
    cfg: (key, value) => g('config', '--local', '--add', key, value),
    script: async (name, tail = 'exit 0') => {
      const file = path.join(bin, `${name}.sh`);
      await writeFile(file, `#!/bin/sh\necho "$0 $*" >> ${marks}/${name}\n${tail}\n`);
      await fs.chmod(file, 0o755);
      return file;
    },
  };
}

async function askpassRepo(url: string, extra: [string, string][] = []): Promise<Ctx> {
  const c = await fresh();
  await c.cfg('core.askPass', await c.script('askpass', 'echo secret'));
  await c.g('remote', 'add', 'origin', url);
  for (const [k, v] of extra) await c.cfg(k, v);
  return c;
}

const url401 = (): string => `http://127.0.0.1:${srv401.port}/r.git`;

const fx = (c: Ctx, argv: string[], mark: string): Fixture => ({
  cwd: c.repo,
  argv,
  marks: c.marks,
  mark,
});

async function gpgBase(extra: [string, string][] = []): Promise<Ctx> {
  const c = await fresh();
  await c.cfg('gpg.program', await c.script('gpg', 'exit 1'));
  for (const [k, v] of extra) await c.cfg(k, v);
  return c;
}

async function gcTrap(): Promise<Ctx> {
  const c = await fresh('gc');
  await c.cfg('gc.autoPackLimit', '1');
  await c.cfg('gc.autoDetach', 'false');
  await c.cfg('maintenance.autoDetach', 'false');
  await c.cfg('maintenance.strategy', 'gc');
  await c.cfg('gc.recentObjectsHook', await c.script('recentobjects', 'exit 0'));
  return c;
}

const CASES: { id: string; setup: () => Promise<Fixture> }[] = [
  {
    id: 'askpass-ls-remote',
    setup: async () => fx(await askpassRepo(url401()), ['ls-remote', 'origin'], 'askpass'),
  },
  {
    id: 'askpass-fetch',
    setup: async () =>
      fx(
        await askpassRepo(url401()),
        ['fetch', '--end-of-options', 'origin', 'refs/heads/main'],
        'askpass',
      ),
  },
  {
    id: 'askpass-push',
    setup: async () => fx(await askpassRepo(url401()), ['push', 'origin', 'main'], 'askpass'),
  },
  {
    id: 'askpass-http-proxy-407',
    setup: async () =>
      fx(
        await askpassRepo('http://example.invalid/r.git', [
          ['http.proxy', `http://user@127.0.0.1:${srv407.port}`],
        ]),
        ['ls-remote', 'origin'],
        'askpass',
      ),
  },
  {
    id: 'gitproxy-ls-remote',
    setup: async () => {
      const c = await fresh();
      await c.cfg('core.gitProxy', await c.script('gitproxy', 'exit 1'));
      await c.g('remote', 'add', 'origin', 'git://127.0.0.1:1/x.git');
      return fx(c, ['ls-remote', 'origin'], 'gitproxy');
    },
  },
  {
    id: 'ext-url',
    setup: async () => {
      const c = await fresh();
      const s = await c.script('ext', 'exit 1');
      await c.cfg('protocol.ext.allow', 'always');
      await c.g('remote', 'add', 'origin', `ext::${s} %S`);
      return fx(c, ['ls-remote', 'origin'], 'ext');
    },
  },
  {
    id: 'ext-via-insteadof',
    setup: async () => {
      const c = await fresh();
      const s = await c.script('ext', 'exit 1');
      await c.cfg('protocol.allow', 'always');
      await c.cfg(`url.ext::${s} %S .insteadOf`, 'https://example.invalid/');
      await c.g('remote', 'add', 'origin', 'https://example.invalid/r.git');
      return fx(c, ['ls-remote', 'origin'], 'ext');
    },
  },
  {
    id: 'gpg-log-showsignature',
    setup: async () =>
      fx(await gpgBase([['log.showSignature', 'true']]), ['log', '-1', 'signed'], 'gpg'),
  },
  {
    id: 'gpg-x509-showsignature',
    setup: async () => {
      const c = await gpgBase([['log.showSignature', 'true']]);
      await c.cfg('gpg.x509.program', await c.script('gpg-x509', 'exit 1'));
      return fx(c, ['log', '-1', 'signed-x509'], 'gpg-x509');
    },
  },
  {
    id: 'gpg-ssh-showsignature',
    setup: async () => {
      const c = await gpgBase([['log.showSignature', 'true']]);
      await c.cfg('gpg.ssh.program', await c.script('gpg-ssh', 'exit 1'));
      const signers = path.join(c.dir, 'allowed_signers');
      await writeFile(
        signers,
        'n@x ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGYaD1EhfJmIXo6mLOjSULFkVEiJ6xZSsUsPu1jPgPwD\n',
      );
      await c.cfg('gpg.ssh.allowedSignersFile', signers);
      return fx(c, ['log', '-1', 'signed-ssh'], 'gpg-ssh');
    },
  },
  {
    id: 'gpg-merge-verifysignatures',
    setup: async () =>
      fx(
        await gpgBase([['merge.verifySignatures', 'true']]),
        ['merge', '--no-edit', 'signed'],
        'gpg',
      ),
  },
  {
    id: 'gpg-tag-forcesignannotated',
    setup: async () =>
      fx(await gpgBase([['tag.forceSignAnnotated', 'true']]), ['tag', '-m', 'm', 'v1'], 'gpg'),
  },
  {
    id: 'gpg-push-gpgsign',
    setup: async () => {
      const c = await gpgBase([['push.gpgSign', 'true']]);
      await gitAt(c.bare)('config', 'receive.certNonceSeed', 'seed');
      await c.g('remote', 'add', 'origin', c.bare);
      await c.g('checkout', '-q', '-b', 'pushme');
      return fx(c, ['push', 'origin', 'pushme'], 'gpg');
    },
  },
  {
    id: 'alternaterefs-client-fetch',
    setup: async () => {
      const c = await fresh();
      await writeFile(
        path.join(c.repo, '.git', 'objects', 'info', 'alternates'),
        `${path.join(c.alt, 'objects')}\n`,
      );
      await c.g('remote', 'add', 'origin', c.bare);
      await c.cfg('core.alternateRefsCommand', await c.script('alternaterefs', 'exit 0'));
      return fx(c, ['fetch', '--end-of-options', 'origin', 'refs/heads/main'], 'alternaterefs');
    },
  },
  {
    id: 'gc-auto-commit',
    setup: async () => {
      const c = await gcTrap();
      await writeFile(path.join(c.repo, 'a.txt'), 'edited\n');
      await c.g('add', '-A');
      return fx(c, ['commit', '-m', 'x'], 'recentobjects');
    },
  },
  {
    id: 'gc-auto-fetch',
    setup: async () => {
      const c = await gcTrap();
      return fx(c, ['fetch', '--end-of-options', 'origin', 'refs/heads/news'], 'recentobjects');
    },
  },
];

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  for (const k of SCRUBBED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'haive-git-program-keys-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  hermetic = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'n',
    GIT_AUTHOR_EMAIL: 'n@x',
    GIT_COMMITTER_NAME: 'n',
    GIT_COMMITTER_EMAIL: 'n@x',
    LANG: 'C',
  };
  srv401 = await listen(challenge(401, 'WWW-Authenticate'));
  srv407 = await listen(challenge(407, 'Proxy-Authenticate'));
  await buildTemplates();
}, 120_000);

afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const k of SCRUBBED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('hardened host git runs no program a repository config names', () => {
  it.each(CASES.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const control = await c.setup();
    await run('git', control.argv, {
      cwd: control.cwd,
      env: { ...process.env, ...hermetic, ...control.env },
      timeout: 15_000,
      maxBuffer: 1 << 26,
    }).catch(() => undefined);
    expect(await exists(path.join(control.marks, control.mark)), 'positive control').toBe(true);

    const hardened = await c.setup();
    await gitRun(hardened.cwd, hardened.argv, { ...hermetic, ...hardened.env });
    expect(await exists(path.join(hardened.marks, hardened.mark))).toBe(false);
  });

  it('a trusted GIT_ASKPASS still wins over the repository askpass', async () => {
    const c = await askpassRepo(url401());
    const trusted = await c.script('trusted', 'echo secret');
    await gitRun(c.repo, ['ls-remote', 'origin'], { ...hermetic, GIT_ASKPASS: trusted });
    expect(await exists(path.join(c.marks, 'trusted'))).toBe(true);
    expect(await exists(path.join(c.marks, 'askpass'))).toBe(false);
  });

  it('the stored credential helper authenticates with no repository program run', async () => {
    const c = await fresh();
    const srv = await smartServer(c.bare, { user: 'haive-user', pass: 'haive-pass' });
    await c.cfg('core.askPass', await c.script('askpass', 'echo wrong'));
    await c.cfg('credential.helper', `!${await c.script('repo-helper', 'exit 0')}`);
    await c.g('remote', 'add', 'origin', `http://127.0.0.1:${srv.port}/bare.git`);
    const helper = await buildCredentialHelper({} as never, 'c', 'u');
    const r = await gitRun(c.repo, [...helper.argv, 'ls-remote', 'origin'], {
      ...hermetic,
      ...helper.env,
    });
    expect(r.code).toBe(0);
    expect(await exists(path.join(c.marks, 'askpass'))).toBe(false);
    expect(await exists(path.join(c.marks, 'repo-helper'))).toBe(false);
  });
});
