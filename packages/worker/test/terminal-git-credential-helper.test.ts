import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_USER_HOME } from '../src/sandbox/sandbox-runner.js';
import { GIT_CRED_HELPER_JS, GIT_CRED_TOKEN_PATH } from '../src/terminal/terminal-container.js';

interface Hit {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

let dir: string;
let tokenFile: string;
let helperFile: string;
let server: http.Server;
let endpoint: string;
let hits: Hit[] = [];
let reply = { status: 200, body: '' };

const CREDENTIAL = { username: 'x-access-token', password: 'ghp_pushsecret' };
const ok = (): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify(CREDENTIAL),
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'haive-git-cred-helper-'));
  tokenFile = path.join(dir, 'token');
  helperFile = path.join(dir, 'helper.mjs');
  await writeFile(
    helperFile,
    GIT_CRED_HELPER_JS.replaceAll(JSON.stringify(GIT_CRED_TOKEN_PATH), JSON.stringify(tokenFile)),
  );
  server = http.createServer((req, res) => {
    hits.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    req.resume();
    res.statusCode = reply.status;
    res.setHeader('content-type', 'application/json');
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/git-credential`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  hits = [];
  reply = ok();
  await rm(tokenFile, { force: true });
});

/** Runs the helper the way git does; async, since the stub server lives in this process. */
function runHelper(opts: {
  envToken?: string;
  op?: string;
  noUrl?: boolean;
}): Promise<{ code: number | null; stdout: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (!opts.noUrl) env.HAIVE_GIT_CRED_URL = endpoint;
  if (opts.envToken !== undefined) env.HAIVE_GIT_CRED_TOKEN = opts.envToken;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperFile, opts.op ?? 'get'], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end('protocol=https\nhost=github.com\n\n');
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

const EMITTED = `username=${CREDENTIAL.username}\npassword=${CREDENTIAL.password}\n`;

describe('git credential helper token source', () => {
  it('names the token file by the exported path, under the sandbox home', () => {
    expect(GIT_CRED_TOKEN_PATH.startsWith(`${SANDBOX_USER_HOME}/`)).toBe(true);
    expect(GIT_CRED_HELPER_JS).toContain(JSON.stringify(GIT_CRED_TOKEN_PATH));
  });

  it('sends the token in the file as the bearer token', async () => {
    await writeFile(tokenFile, 'token-from-file');
    const result = await runHelper({});
    expect(hits).toEqual([
      {
        method: 'POST',
        url: '/internal/git-credential',
        authorization: 'Bearer token-from-file',
      },
    ]);
    expect(result).toEqual({ code: 0, stdout: EMITTED });
  });

  it('prefers the file over the env token, which an older container keeps for good', async () => {
    await writeFile(tokenFile, 'fresh-file-token');
    await runHelper({ envToken: 'expired-env-token' });
    expect(hits.map((h) => h.authorization)).toEqual(['Bearer fresh-file-token']);
  });

  it('ignores whitespace around the token in the file', async () => {
    await writeFile(tokenFile, '  token-from-file\n');
    await runHelper({});
    expect(hits.map((h) => h.authorization)).toEqual(['Bearer token-from-file']);
  });

  it('still works from the env token alone, for a container created before the file', async () => {
    const result = await runHelper({ envToken: 'token-from-env' });
    expect(hits.map((h) => h.authorization)).toEqual(['Bearer token-from-env']);
    expect(result).toEqual({ code: 0, stdout: EMITTED });
  });

  it('falls back to the env token when the file is empty', async () => {
    await writeFile(tokenFile, '');
    await runHelper({ envToken: 'token-from-env' });
    expect(hits.map((h) => h.authorization)).toEqual(['Bearer token-from-env']);
  });
});

describe('git credential helper failure', () => {
  it('emits nothing and exits 0 with neither a file nor an env token', async () => {
    const result = await runHelper({});
    expect(hits).toEqual([]);
    expect(result).toEqual({ code: 0, stdout: '' });
  });

  it('emits nothing and exits 0 without the endpoint', async () => {
    const result = await runHelper({ envToken: 'token-from-env', noUrl: true });
    expect(hits).toEqual([]);
    expect(result).toEqual({ code: 0, stdout: '' });
  });

  it.each([401, 404, 500])('emits nothing and exits 0 on a %i', async (status) => {
    reply = { status, body: JSON.stringify(CREDENTIAL) };
    const result = await runHelper({ envToken: 'token-from-env' });
    expect(hits).toHaveLength(1);
    expect(result).toEqual({ code: 0, stdout: '' });
  });

  it('emits nothing on a 204, the answer for a repository with no stored credential', async () => {
    reply = { status: 204, body: '' };
    const result = await runHelper({ envToken: 'token-from-env' });
    expect(hits).toHaveLength(1);
    expect(result).toEqual({ code: 0, stdout: '' });
  });

  it('emits nothing for a body that is not JSON', async () => {
    reply = { status: 200, body: 'not json' };
    const result = await runHelper({ envToken: 'token-from-env' });
    expect(hits).toHaveLength(1);
    expect(result).toEqual({ code: 0, stdout: '' });
  });

  it.each(['store', 'erase'])('does nothing for git’s %s', async (op) => {
    const result = await runHelper({ envToken: 'token-from-env', op });
    expect(hits).toEqual([]);
    expect(result).toEqual({ code: 0, stdout: '' });
  });

  it('emits nothing on a 401 for the token in the file either', async () => {
    reply = { status: 401, body: JSON.stringify(CREDENTIAL) };
    await writeFile(tokenFile, 'expired-file-token');
    const result = await runHelper({});
    expect(hits.map((h) => h.authorization)).toEqual(['Bearer expired-file-token']);
    expect(result).toEqual({ code: 0, stdout: '' });
  });
});
