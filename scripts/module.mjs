import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import local from './local-modules.cjs';
import { publicModuleLock } from './public-module-lock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command, target, ...extra] = process.argv.slice(2);

const fail = (message) => {
  console.error(`module: ${message}`);
  process.exit(1);
};

if (command === 'lock' && target === undefined) {
  if (publicModuleLock(root).status !== 0) fail('public lock refresh failed');
  if (
    local.localMode() &&
    spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' }).status !== 0
  )
    fail('public lock updated, but refreshing the local lock failed');
  console.log('module: refreshed pnpm-lock.yaml from the public workspace');
  process.exit(0);
}

if ((command !== 'add' && command !== 'remove') || target === undefined || extra.length > 0) {
  console.error(
    'usage: pnpm module add <id> | pnpm module add @haive-module/<id>@<version> | pnpm module remove <id> | pnpm module remove @haive-module/<id> | pnpm module lock',
  );
  process.exit(1);
}
const registry = /^@haive-module\/([a-z0-9][a-z0-9-]*)(?:@(.*))?$/.exec(target);
const id = registry?.[1] ?? target;
const version = registry?.[2];
if (!/^[a-z0-9][a-z0-9-]{0,22}$/.test(id)) {
  fail(`"${id}" is not a module id (id = [a-z0-9][a-z0-9-]*, at most 23 characters)`);
}
if (
  registry !== null &&
  command === 'add' &&
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version ?? '')
) {
  fail(`@haive-module/${id} needs an exact version: pnpm module add @haive-module/${id}@<version>`);
}
if (registry !== null && command === 'remove' && version !== undefined) {
  fail(`remove takes the package name without a version: pnpm module remove @haive-module/${id}`);
}

// Clones outside the public modules tree use only ignored local selection/lock state.
const selected = local.selection();
const externalFile = join(local.directory, id, 'package.json');
if (registry === null && (existsSync(externalFile) || selected[id] !== undefined)) {
  if (existsSync(join(root, 'modules', id, 'package.json')))
    fail(`${id} exists in both module trees; keep one`);
  const before = existsSync(local.selectionFile) ? readFileSync(local.selectionFile, 'utf8') : null;
  if (command === 'add') {
    const pkg = JSON.parse(readFileSync(externalFile, 'utf8'));
    if (
      ![`@haive/module-${id}`, `@haive-module/${id}`].includes(pkg.name) ||
      pkg.exports?.['./manifest'] === undefined
    )
      fail(`${externalFile} needs a matching module name and ./manifest export`);
    selected[id] = { name: pkg.name };
  } else delete selected[id];
  mkdirSync(local.directory, { recursive: true });
  if (Object.keys(selected).length)
    writeFileSync(local.selectionFile, `${JSON.stringify(selected, null, 2)}\n`);
  else rmSync(local.selectionFile, { force: true });
  const lock = spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
  if (lock.status !== 0) {
    if (before === null) rmSync(local.selectionFile, { force: true });
    else writeFileSync(local.selectionFile, before);
    fail('pnpm install --lockfile-only failed; local selection was reverted');
  }
  const gen = spawnSync(process.execPath, [join(root, 'scripts/gen-modules.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (gen.status !== 0) fail('gen-modules rejected the local selection above');
  console.log(
    `module: ${command === 'add' ? 'added' : 'removed'} external ${id}; host manifests and pnpm-lock.yaml unchanged`,
  );
  console.log(
    'module: next, run pnpm install, build, then pnpm docker rebuild; local clones are excluded from tagged channel builds',
  );
  process.exit(0);
}

let name = registry === null ? `@haive/module-${id}` : `@haive-module/${id}`;
const spec = registry === null ? 'workspace:*' : version;
let modulePackage = null;
if (registry === null) {
  try {
    modulePackage = JSON.parse(readFileSync(join(root, 'modules', id, 'package.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // A folder may already carry its registry name; it is linked through workspace:* all the same.
  if (modulePackage?.name === `@haive-module/${id}`) name = modulePackage.name;
} else if (command === 'add') {
  // --lockfile-only installs nothing and pnpm's resolution metadata omits exports, so ask the registry for the full document.
  const view = spawnSync('pnpm', ['view', `${name}@${version}`, 'exports', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (view.status !== 0) {
    fail(
      `pnpm view ${name}@${version} exports failed${view.error ? `: ${view.error.message}` : `:\n${view.stderr}`}`,
    );
  }
  modulePackage = {
    name,
    exports: view.stdout.trim() === '' ? undefined : JSON.parse(view.stdout),
  };
}
if (command === 'add') {
  if (modulePackage === null) fail(`modules/${id}/package.json not found`);
  if (modulePackage.name !== name) {
    fail(
      `modules/${id}/package.json is named ${modulePackage.name}, not @haive/module-${id} or @haive-module/${id}`,
    );
  }
  if (modulePackage.exports?.['./manifest'] === undefined) {
    fail(`${name} does not export ./manifest; a module needs a manifest`);
  }
}
const webPart =
  modulePackage?.exports?.['./web'] !== undefined ||
  modulePackage?.exports?.['./dashboard'] !== undefined;

// Splices the dependencies block as text, so the rest of the file keeps the formatting it has.
const DEPENDENCIES = /^( {2}"dependencies": )(\{[^}]*\})/m;
const withDependency = (text, rel, wanted) => {
  const match = DEPENDENCIES.exec(text);
  if (match === null) fail(`${rel} has no dependencies block`);
  const entries = Object.entries(JSON.parse(match[2]));
  const held = entries.find(([key]) => key === name);
  if (wanted ? held?.[1] === spec : held === undefined) return text;
  const next = entries.filter(([key]) => key !== name);
  if (wanted) {
    const at = next.findIndex(([key]) => key > name);
    next.splice(at === -1 ? next.length : at, 0, [name, spec]);
  }
  const block = JSON.stringify(Object.fromEntries(next), null, 2).replaceAll('\n', '\n  ');
  return (
    text.slice(0, match.index + match[1].length) + block + text.slice(match.index + match[0].length)
  );
};

const changes = ['api', 'worker', 'web'].flatMap((host) => {
  const rel = `packages/${host}/package.json`;
  const before = readFileSync(join(root, rel), 'utf8');
  const after = withDependency(before, rel, command === 'add' && (host !== 'web' || webPart));
  return after === before ? [] : [{ rel, before, after }];
});

if (changes.length === 0) {
  if (command === 'remove' && modulePackage === null) {
    fail(
      registry === null
        ? `no module "${id}": modules/${id}/ does not exist and no package.json depends on ${name}`
        : `no module "${name}": no package.json depends on it`,
    );
  }
  console.log(
    `module: ${name} is ${command === 'add' ? 'already' : 'not'} installed; nothing to do`,
  );
  process.exit(0);
}

for (const { rel, after } of changes) writeFileSync(join(root, rel), after);
const lock = local.localMode()
  ? publicModuleLock(root)
  : spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
if (lock.status !== 0) {
  for (const { rel, before } of changes) writeFileSync(join(root, rel), before);
  fail(
    `pnpm install --lockfile-only failed${lock.error ? `: ${lock.error.message}` : ''}; the package.json edits were reverted`,
  );
}
if (local.localMode()) {
  const localLock = spawnSync('pnpm', ['install', '--lockfile-only'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (localLock.status !== 0) fail('public lock updated, but refreshing the local lock failed');
}
const INSTALL_MAY_LAG = 'HAIVE_INSTALL_MAY_LAG';
const gen = spawnSync(process.execPath, [join(root, 'scripts', 'gen-modules.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, [INSTALL_MAY_LAG]: '1' },
});
if (gen.status !== 0) {
  fail('gen-modules rejected the result above; the dependency lists and pnpm-lock.yaml are edited');
}

const where = changes.map(({ rel }) => dirname(rel)).join(', ');
if (command === 'add') {
  console.log(`module: added ${name} to ${where} and updated pnpm-lock.yaml`);
  console.log(
    `module: next, run "pnpm docker rebuild" with no service name; /admin/modules then shows ${id} as Loaded`,
  );
} else {
  console.log(`module: removed ${name} from ${where} and updated pnpm-lock.yaml`);
  console.log(
    registry === null
      ? `module: modules/${id}/ is untouched, and no database or Redis key was touched`
      : 'module: no database or Redis key was touched',
  );
  console.log(
    `module: next, run "pnpm docker rebuild" with no service name; /admin/modules then shows ${id} as Missing, with its data kept`,
  );
}
