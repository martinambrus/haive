import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Adding a public module requires an explicit entry in this reviewed list.
export function checkPublicModules(files) {
  const errors = [];
  const publicIds = new Set();
  const listFile = 'public-modules.json';
  try {
    const ids = JSON.parse(String(files.get(listFile)));
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,22}$/.test(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new Error('invalid public module list');
    for (const id of ids) publicIds.add(id);
  } catch {
    errors.push(`${listFile}: missing or invalid public module list`);
  }
  const moduleName = /^(?:@haive\/module-|@haive-module\/)([a-z0-9][a-z0-9-]{0,22})$/;
  for (const [file, bytes] of files) {
    const folder = /^modules\/([^/]+)\//.exec(file);
    if (folder && !publicIds.has(folder[1]))
      errors.push(`${file}: non-public module folder ${folder[1]} must not be tracked`);
    const path = /^modules\/([^/]+)\/package\.json$/.exec(file);
    if (!path) continue;
    try {
      const pkg = JSON.parse(String(bytes));
      const id = moduleName.exec(pkg.name)?.[1];
      if (id !== path[1]) errors.push(`${file}: public module package must match its folder`);
    } catch {
      errors.push(`${file}: unreadable public module manifest`);
    }
  }
  for (const [file, bytes] of files) {
    if (file.startsWith('external-modules/') && file !== 'external-modules/.gitkeep')
      errors.push(`${file}: external module state/source must not be tracked`);
    // Prose and synthetic tests document arbitrary package names without installing
    // them. Manifests and lockfiles are always checked, even under test directories.
    const installInput = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(
      file,
    );
    if (
      file === 'tests/fixtures/registry-module/package.json' ||
      file === 'scripts/smoke/check-registry-list.mjs' ||
      file === 'scripts/module-dist-smoke.sh'
    )
      continue;
    if (
      !installInput &&
      (file.endsWith('.md') || /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|\.test\.[^.]+$/.test(file))
    )
      continue;
    let text = String(bytes);
    if (file.endsWith('/package.json') || file === 'package.json') {
      try {
        text = JSON.stringify(JSON.parse(text));
      } catch {
        errors.push(`${file}: unreadable package manifest`);
      }
    }
    for (const match of text.matchAll(/@haive(?:\/module-|-module\/)([a-z0-9][a-z0-9-]*)/g)) {
      if (!publicIds.has(match[1])) errors.push(`${file}: non-public module ${match[0]}`);
    }
    if (installInput) {
      for (const match of text.matchAll(
        /(?:^|[\s"'])((?:external-modules|modules)\/([a-z0-9][a-z0-9-]*))(?=[/\s"':]|$)/gm,
      )) {
        if (match[1].startsWith('external-modules/') || !publicIds.has(match[2]))
          errors.push(`${file}: non-public workspace/importer ${match[1]}`);
      }
    }
  }
  return [...new Set(errors)];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync('/usr/bin/git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('could not enumerate tracked files');
  const files = new Map(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) => [file, readFileSync(join(root, file))]),
  );
  const errors = checkPublicModules(files);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else
    console.log(
      'public-modules: PASS (tracked install/runtime references match the declared public modules)',
    );
}
