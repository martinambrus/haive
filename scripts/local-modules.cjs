// Shared by pnpm and code generation: private dependencies never enter host manifests.
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const root = join(__dirname, '..');
const directory = join(root, 'external-modules');
const selectionFile = join(directory, '.selection.json');
const moduleId = /^(?:@haive\/module-|@haive-module\/)([a-z0-9][a-z0-9-]{0,22})$/;
const folders = () =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
    : [];
const localMode = () => existsSync(selectionFile) || folders().length > 0;
function selection() {
  if (!existsSync(selectionFile)) return {};
  try {
    const value = JSON.parse(readFileSync(selectionFile, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    for (const [id, entry] of Object.entries(value)) {
      if (moduleId.exec(entry?.name)?.[1] !== id) throw new Error();
    }
    return value;
  } catch {
    throw new Error(
      'invalid external module selection; delete external-modules/.selection.json and re-add your modules',
    );
  }
}
function effectivePackage(pkg) {
  if (!['@haive/api', '@haive/worker', '@haive/web'].includes(pkg.name)) return pkg;
  const dependencies = { ...pkg.dependencies };
  for (const [id, entry] of Object.entries(selection())) {
    const file = join(directory, id, 'package.json');
    if (!existsSync(file))
      throw new Error(
        `selected external module ${entry.name} is missing; restore its clone or run pnpm module remove ${id}`,
      );
    const clone = JSON.parse(readFileSync(file, 'utf8'));
    const web =
      clone.exports?.['./web'] !== undefined || clone.exports?.['./dashboard'] !== undefined;
    if (pkg.name !== '@haive/web' || web) dependencies[entry.name] = 'workspace:*';
  }
  return { ...pkg, dependencies };
}
function updateConfig(config) {
  if (!localMode()) return config;
  const lockfileDir = join(directory, '.lock');
  mkdirSync(lockfileDir, { recursive: true });
  const file = join(lockfileDir, 'pnpm-lock.yaml');
  const seedFile = join(lockfileDir, '.seed.sha256');
  const canonicalFile = join(root, 'pnpm-lock.yaml');
  const canonical = existsSync(canonicalFile) ? readFileSync(canonicalFile, 'utf8') : null;
  const hash = canonical === null ? null : createHash('sha256').update(canonical).digest('hex');
  if (
    canonical !== null &&
    (!existsSync(file) || !existsSync(seedFile) || readFileSync(seedFile, 'utf8') !== hash)
  ) {
    // Importer keys are relative to the lockfile directory; link: values remain relative to importers.
    const seeded = canonical.replace(
      /(importers:\n)([\s\S]*?)(?=^\S|$(?![\s\S]))/m,
      (_, heading, body) =>
        heading +
        body.replace(
          /^  ([^ \n][^\n]*):$/gm,
          (_, key) => `  ${key === '.' ? '../..' : `../../${key}`}:`,
        ),
    );
    writeFileSync(file, seeded);
    writeFileSync(seedFile, hash);
  }
  return {
    ...config,
    lockfileDir,
    virtualStoreDir: join(root, 'node_modules', '.pnpm'),
    frozenLockfile: false,
  };
}
module.exports = {
  directory,
  selectionFile,
  folders,
  localMode,
  selection,
  effectivePackage,
  updateConfig,
};
