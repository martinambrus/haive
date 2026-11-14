// Shared by pnpm and code generation: private dependencies never enter host manifests.
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
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
  const value = JSON.parse(readFileSync(selectionFile, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('invalid external module selection');
  for (const [id, entry] of Object.entries(value)) {
    if (moduleId.exec(entry?.name)?.[1] !== id || typeof entry.web !== 'boolean')
      throw new Error('invalid external module selection');
  }
  return value;
}
function effectivePackage(pkg) {
  if (!['@haive/api', '@haive/worker', '@haive/web'].includes(pkg.name)) return pkg;
  const dependencies = { ...pkg.dependencies };
  for (const entry of Object.values(selection())) {
    if (pkg.name !== '@haive/web' || entry.web) dependencies[entry.name] = 'workspace:*';
  }
  return { ...pkg, dependencies };
}
function updateConfig(config) {
  if (!localMode()) return config;
  const lockfileDir = join(directory, '.lock');
  mkdirSync(lockfileDir, { recursive: true });
  const file = join(lockfileDir, 'pnpm-lock.yaml');
  if (!existsSync(file) && existsSync(join(root, 'pnpm-lock.yaml'))) {
    // Importer keys are relative to the lockfile directory; link: values remain relative to importers.
    const canonical = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
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
