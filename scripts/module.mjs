import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command, id, ...extra] = process.argv.slice(2);

const fail = (message) => {
  console.error(`module: ${message}`);
  process.exit(1);
};

if ((command !== 'add' && command !== 'remove') || id === undefined || extra.length > 0) {
  console.error('usage: pnpm module add <id> | pnpm module remove <id>');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  fail(`"${id}" is not a module id (id = [a-z0-9][a-z0-9-]*)`);
}

const name = `@haive/module-${id}`;
let modulePackage = null;
try {
  modulePackage = JSON.parse(readFileSync(join(root, 'modules', id, 'package.json'), 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (command === 'add') {
  if (modulePackage === null) fail(`modules/${id}/package.json not found`);
  if (modulePackage.name !== name) {
    fail(`modules/${id}/package.json is named ${modulePackage.name}, not ${name}`);
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
  if (entries.some(([key]) => key === name) === wanted) return text;
  const next = entries.filter(([key]) => key !== name);
  if (wanted) {
    const at = next.findIndex(([key]) => key > name);
    next.splice(at === -1 ? next.length : at, 0, [name, 'workspace:*']);
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
    fail(`no module "${id}": modules/${id}/ does not exist and no package.json depends on ${name}`);
  }
  console.log(
    `module: ${name} is ${command === 'add' ? 'already' : 'not'} installed; nothing to do`,
  );
  process.exit(0);
}

for (const { rel, after } of changes) writeFileSync(join(root, rel), after);
const lock = spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
if (lock.status !== 0) {
  for (const { rel, before } of changes) writeFileSync(join(root, rel), before);
  fail(
    `pnpm install --lockfile-only failed${lock.error ? `: ${lock.error.message}` : ''}; the package.json edits were reverted`,
  );
}
const gen = spawnSync(process.execPath, [join(root, 'scripts', 'gen-modules.mjs')], {
  cwd: root,
  stdio: 'inherit',
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
  console.log(`module: modules/${id}/ is untouched, and no database or Redis key was touched`);
  console.log(
    `module: next, run "pnpm docker rebuild" with no service name; /admin/modules then shows ${id} as Missing, with its data kept`,
  );
}
