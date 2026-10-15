// A fake npm registry for scripts/module-dist-smoke.sh: node, no dependencies.
//   FAKE_NPM_TOKEN=<token> node fake-npm-registry.mjs <tarball-dir> [port]
// Serves every *.tgz in <tarball-dir> (metadata and tarball) to `Authorization: Bearer <token>`
// and answers 401 to anything else. /-/ping is open. Each request is logged with how it
// authenticated (auth=ok|bad|none) and never with the token.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [dir, portArg] = process.argv.slice(2);
const token = process.env.FAKE_NPM_TOKEN;
if (!dir || !token) {
  console.error('usage: FAKE_NPM_TOKEN=<token> node fake-npm-registry.mjs <tarball-dir> [port]');
  process.exit(2);
}

function field(buf, offset, length) {
  const end = buf.indexOf(0, offset);
  return buf.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
}

function packageJsonOf(tgz) {
  const tar = gunzipSync(tgz);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = field(tar, offset, 100);
    if (name === '') break;
    const size = parseInt(field(tar, offset + 124, 12).trim() || '0', 8);
    if (name === 'package/package.json') {
      return JSON.parse(tar.toString('utf8', offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('a tarball without package/package.json');
}

const baseOf = (name) => name.slice(name.lastIndexOf('/') + 1);
const tarballPath = (name, version) => `/${name}/-/${baseOf(name)}-${version}.tgz`;

const packages = new Map();
const tarballs = new Map();
for (const file of readdirSync(dir).filter((f) => f.endsWith('.tgz'))) {
  const tgz = readFileSync(join(dir, file));
  const manifest = packageJsonOf(tgz);
  const entry = packages.get(manifest.name) ?? new Map();
  entry.set(manifest.version, {
    manifest,
    integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
    shasum: createHash('sha1').update(tgz).digest('hex'),
  });
  packages.set(manifest.name, entry);
  tarballs.set(tarballPath(manifest.name, manifest.version), tgz);
}
if (packages.size === 0) {
  console.error(`no *.tgz in ${dir}`);
  process.exit(2);
}

function packument(name, versions, origin) {
  const now = new Date().toISOString();
  const numbers = [...versions.keys()];
  return {
    _id: name,
    name,
    'dist-tags': { latest: numbers[numbers.length - 1] },
    versions: Object.fromEntries(
      [...versions].map(([version, v]) => [
        version,
        {
          ...v.manifest,
          _id: `${name}@${version}`,
          dist: {
            tarball: `${origin}${tarballPath(name, version)}`,
            shasum: v.shasum,
            integrity: v.integrity,
          },
        },
      ]),
    ),
    time: { created: now, modified: now, ...Object.fromEntries(numbers.map((v) => [v, now])) },
  };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = createServer((req, res) => {
  const supplied = req.headers.authorization;
  const auth = supplied === undefined ? 'none' : supplied === `Bearer ${token}` ? 'ok' : 'bad';
  let path = '';
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    path = '';
  }
  let status = 404;
  if (path === '/-/ping') {
    status = 200;
    send(res, status, {});
  } else if (auth !== 'ok') {
    status = 401;
    send(res, status, { error: 'unauthorized' });
  } else if (packages.has(path.slice(1))) {
    status = 200;
    send(
      res,
      status,
      packument(path.slice(1), packages.get(path.slice(1)), `http://${req.headers.host}`),
    );
  } else if (tarballs.has(path)) {
    status = 200;
    send(res, status, tarballs.get(path), 'application/octet-stream');
  } else {
    send(res, status, { error: 'not found' });
  }
  console.log(`${new Date().toISOString()} ${req.method} ${path} ${status} auth=${auth}`);
});

process.on('SIGTERM', () => process.exit(0));
server.listen(Number(portArg ?? 4873), '0.0.0.0', () => {
  console.log(`listening ${[...packages.keys()].join(',')}`);
});
