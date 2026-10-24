import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { hardenGitArgs } from '../../../shared/dist/git-args.js';

// A separate process lets fixtures that use execFileSync still speak real smart HTTP.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const child = spawn('git', hardenGitArgs(['-c', 'http.receivepack=true', 'http-backend']), {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: '/',
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
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
