import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { GIT_CRED_HELPER_JS, GIT_CRED_TOKEN_PATH } from '../src/terminal/terminal-container.js';

it('the installed terminal script forwards Git host and protocol to the credential route', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haive-terminal-credential-'));
  let request: unknown;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    request = JSON.parse(body);
    res.end(JSON.stringify({ username: 'fixture-user', password: 'fixture-password' }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture not listening');
    await writeFileNoFollow(root, 'token', 'fixture-token');
    await writeFileNoFollow(
      root,
      'helper.mjs',
      GIT_CRED_HELPER_JS.replace(
        JSON.stringify(GIT_CRED_TOKEN_PATH),
        JSON.stringify(`${root}/token`),
      ),
    );
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`${root}/helper.mjs`, 'get'], {
        env: {
          ...process.env,
          HAIVE_GIT_CRED_URL: `http://127.0.0.1:${address.port}/internal/git-credential`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
      child.stdin.end('protocol=https\nhost=example.test:8443\npath=owner/repo\n\n');
    });
    expect(result.code).toBe(0);
    expect(request).toEqual({ protocol: 'https', host: 'example.test:8443' });
    expect(result.output.includes('password=')).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
