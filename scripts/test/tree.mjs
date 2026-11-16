import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const sorted = (entries) =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The compact `files` array is what prettier keeps and JSON.stringify would expand, so an edit that
// re-serialises the whole file shows up as a diff outside the dependencies block.
const hostText = (name, dependencies) =>
  `{\n  "name": "${name}",\n  "files": ["dist"],\n  "dependencies": ${JSON.stringify(dependencies, null, 2).replaceAll('\n', '\n  ')},\n  "devDependencies": {\n    "vitest": "^5.0.3"\n  }\n}\n`;

const moduleText = (
  id,
  { name = `@haive/module-${id}`, version = '0.1.0', exports = ['./manifest'] },
) =>
  `${JSON.stringify(
    {
      name,
      version,
      type: 'module',
      exports: Object.fromEntries(
        exports.map((key) => [key, { import: `./dist/${key.slice(2)}.js` }]),
      ),
    },
    null,
    2,
  )}\n`;

// Both scripts take their root from their own location, so a copy of them inside a temp tree runs
// against that tree. `pnpm` is a stub that logs its working directory and arguments.
export function makeTree(
  t,
  {
    modules = {},
    api = [],
    worker = [],
    web = [],
    installed = {},
    base = { '@haive/shared': 'workspace:*', zod: '^4.6.5' },
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'haive-module-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'tree');
  const bin = join(dir, 'bin');
  const log = join(dir, 'pnpm.log');
  const npmLog = join(dir, 'npm.log');

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'modules'), { recursive: true });
  mkdirSync(join(root, 'external-modules'), { recursive: true });
  for (const script of [
    'gen-modules.mjs',
    'module.mjs',
    'registry-module.mjs',
    'local-modules.cjs',
    'public-module-lock.mjs',
    'workspace-task.mjs',
  ]) {
    copyFileSync(join(scriptsDir, script), join(root, 'scripts', script));
  }
  put(
    join(bin, 'pnpm'),
    `#!/bin/sh\necho "$(pwd -P) $*" >> "${log}"\nif [ "$1" = view ]; then\n  printf '%s' "$STUB_PNPM_VIEW"\n  [ "\${STUB_PNPM_VIEW_EXIT:-0}" = 0 ] || echo "npm error code E404" >&2\n  exit "\${STUB_PNPM_VIEW_EXIT:-0}"\nfi\nexit "\${STUB_PNPM_EXIT:-0}"\n`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  // Never fall through to the real npm: the fallback must stay offline too.
  put(
    join(bin, 'npm'),
    `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const scratch = args[args.indexOf('--pack-destination') + 1];
appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify({ args, scratch }) + '\\n');
if (process.env.STUB_NPM_EXIT) {
  process.stderr.write('stub npm pack failure');
  process.exit(Number(process.env.STUB_NPM_EXIT));
}
const source = join(scratch, 'source');
mkdirSync(join(source, 'package'), { recursive: true });
const manifest = JSON.stringify({
  name: '@haive-module/foo', version: '1.0.0',
  ...(process.env.STUB_NPM_EXPORTS ? { exports: JSON.parse(process.env.STUB_NPM_EXPORTS) } : {}),
});
if (process.env.STUB_NPM_SYMLINK) {
  writeFileSync(join(source, 'manifest.json'), manifest);
  symlinkSync('../manifest.json', join(source, 'package/package.json'));
} else writeFileSync(join(source, 'package/package.json'), manifest);
const packed = spawnSync('tar', ['-czf', join(scratch, 'x.tgz'), '-C', source, 'package']);
if (packed.status !== 0) process.exit(2);
process.stdout.write(JSON.stringify([{ filename: process.env.STUB_NPM_FILENAME ?? 'x.tgz', size: Number(process.env.STUB_NPM_SIZE ?? 256) }]));
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  put(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

  const hosts = { api, worker, web };
  for (const [host, names] of Object.entries(hosts)) {
    const dependencies = sorted([
      ...Object.entries(base),
      ...names.map((name) => [name, name.startsWith('@haive-module/') ? '1.0.0' : 'workspace:*']),
    ]);
    put(join(root, 'packages', host, 'package.json'), hostText(`@haive/${host}`, dependencies));
  }
  for (const [id, options] of Object.entries(modules)) {
    put(join(root, 'modules', id, 'package.json'), moduleText(id, options));
  }
  for (const [id, options] of Object.entries(installed)) {
    const name = `@haive-module/${id}`;
    put(
      join(root, 'packages', 'api', 'node_modules', name, 'package.json'),
      moduleText(id, { name, version: '1.0.0', ...options }),
    );
  }

  const files = () =>
    readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && relative(root, entry.parentPath).split(sep)[0] !== 'scripts',
    );
  return {
    root,
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    has: (rel) => existsSync(join(root, rel)),
    snapshot: () =>
      Object.fromEntries(
        files().map((entry) => {
          const file = join(entry.parentPath, entry.name);
          return [relative(root, file), readFileSync(file, 'utf8')];
        }),
      ),
    npmCalls: () =>
      existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').map(JSON.parse) : [],
    pnpmCalls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    run: (script, args = [], env = {}) =>
      spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
      }),
  };
}

export const names = (...ids) => ids.map((id) => `@haive/module-${id}`);
export const registry = (...ids) => ids.map((id) => `@haive-module/${id}`);
