import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

const base = process.argv[2];
if (!base || !path.isAbsolute(base)) throw new Error('fixture base directory required');
const auth = process.env.HAIVE_FIXTURE_AUTH ? JSON.parse(process.env.HAIVE_FIXTURE_AUTH) : null;
const expected = auth
  ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  : null;
let authenticated = 0;

// receive-pack runs auto maintenance after every push, detached on newer git: the likeliest
// writer still in a bare when a test removes it (ENOTEMPTY). Removals retry as well.
const BACKEND_ARGS = ['-c', 'http.receivepack=true', '-c', 'receive.autogc=false', 'http-backend'];

// The alpine worker image has no git http-backend in git --exec-path.
// These fixtures run on the host and in CI only.
// A separate process lets fixtures that use execFileSync still speak real smart HTTP.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__fixture_stats') {
    res.end(JSON.stringify({ authenticated }));
    return;
  }
  if (req.headers.authorization) authenticated++;
  if (expected && req.headers.authorization !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const child = spawn('git', BACKEND_ARGS, {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_PARAMETERS: '',
      GIT_CONFIG_COUNT: '0',
      GIT_PROJECT_ROOT: base,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      REMOTE_USER: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  req.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stderr.resume();
  let pending = Buffer.alloc(0);
  let headers = false;
  child.stdout.on('data', (data) => {
    if (headers) {
      res.write(data);
      return;
    }
    pending = Buffer.concat([pending, data]);
    const at = pending.indexOf('\r\n\r\n');
    if (at < 0) return;
    for (const line of pending.subarray(0, at).toString().split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
      else res.setHeader(key, value);
    }
    headers = true;
    res.write(pending.subarray(at + 4));
  });
  child.on('close', () => {
    if (!headers) res.statusCode = 500;
    res.end();
  });
  child.on('error', () => {
    res.statusCode = 500;
    res.end();
  });
});
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`),
);
