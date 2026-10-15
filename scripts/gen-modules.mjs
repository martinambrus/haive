import { chownSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = join(root, 'modules');
// Copy of the pattern behind modulePackageId in @haive/shared/modularity; packages/shared/test/modularity.test.ts pins the two equal.
const MODULE_PACKAGE = /^(?:@haive\/module-|@haive-module\/)([a-z0-9][a-z0-9-]{0,22})$/;
const idOf = (name) => MODULE_PACKAGE.exec(name)?.[1] ?? null;

const folders = readdirSync(modulesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(modulesDir, entry.name, 'package.json'))
  .flatMap((file) => {
    try {
      return [
        {
          ...JSON.parse(readFileSync(file, 'utf8')),
          dir: basename(dirname(file)),
          source: 'local',
        },
      ];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  });

const apiPackage = JSON.parse(readFileSync(join(root, 'packages', 'api', 'package.json'), 'utf8'));
const workerPackage = JSON.parse(
  readFileSync(join(root, 'packages', 'worker', 'package.json'), 'utf8'),
);
const webPackage = JSON.parse(readFileSync(join(root, 'packages', 'web', 'package.json'), 'utf8'));
const dependsOn = (host, pkg) => host.dependencies?.[pkg.name] !== undefined;
const specOf = (pkg) => (pkg.source === 'registry' ? pkg.version : 'workspace:*');

// A registry module is a dependency named @haive-module/<id> that no workspace folder provides.
const registryNames = (host) =>
  Object.keys(host.dependencies ?? {}).filter(
    (name) => name.startsWith('@haive-module/') && !folders.some((folder) => folder.name === name),
  );
const apiRegistryNames = registryNames(apiPackage);
const registry = apiRegistryNames.flatMap((name) => {
  const file = join('packages', 'api', 'node_modules', name, 'package.json');
  try {
    return [{ ...JSON.parse(readFileSync(join(root, file), 'utf8')), source: 'registry' }];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.log(
      `gen-modules: ${name} is a dependency of @haive/api but ${file} does not exist; run pnpm install`,
    );
    return [];
  }
});
for (const pkg of registry) {
  if (pkg.exports?.['./manifest'] === undefined) {
    console.error(
      `gen-modules: ${pkg.name} is a dependency of @haive/api but exports no ./manifest; every @haive-module/<id> package must`,
    );
    process.exit(1);
  }
}
const packages = [...folders, ...registry].sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
);

const providers = new Map();
for (const [name, where] of [
  ...folders
    .filter((pkg) => pkg.exports?.['./manifest'] !== undefined)
    .map((pkg) => [pkg.name, `modules/${pkg.dir}`]),
  ...apiRegistryNames.map((name) => [name, 'a dependency of @haive/api']),
]) {
  const id = idOf(name);
  if (id === null) continue;
  if (providers.has(id)) {
    console.error(
      `gen-modules: module id "${id}" is provided by both ${providers.get(id)} and ${name} (${where}); keep one`,
    );
    process.exit(1);
  }
  providers.set(id, `${name} (${where})`);
}

const HOSTS = [
  { host: '@haive/api', file: 'packages/api/package.json', pkg: apiPackage },
  { host: '@haive/worker', file: 'packages/worker/package.json', pkg: workerPackage },
  { host: '@haive/web', file: 'packages/web/package.json', pkg: webPackage },
];
const hostsHolding = (name) => HOSTS.filter(({ pkg }) => pkg.dependencies?.[name] !== undefined);
// pnpm links a workspace folder only through the workspace: protocol; any other spec installs the registry copy.
for (const folder of folders.filter(({ name }) => name.startsWith('@haive-module/'))) {
  const pinned = hostsHolding(folder.name).filter(
    ({ pkg }) => !String(pkg.dependencies[folder.name]).startsWith('workspace:'),
  );
  if (pinned.length > 0) {
    console.error(
      `gen-modules: ${folder.name} is the folder modules/${folder.dir}, but ${pinned.map(({ file, pkg }) => `${file} pins it to "${pkg.dependencies[folder.name]}"`).join(', ')}, which pnpm installs from the registry instead; depend on the folder as "workspace:*" or rename its package`,
    );
    process.exit(1);
  }
}
const holdersOf = (name) =>
  hostsHolding(name)
    .filter(({ pkg }) => pkg !== apiPackage)
    .map(({ host }) => host);
const missingFromApi = (name, spec, holders) => {
  console.error(
    `gen-modules: ${name} is a dependency of ${holders.join(' and ')} but not of @haive/api; add "${name}": "${spec}" to packages/api/package.json`,
  );
  process.exit(1);
};

// Installed means the api depends on it. A folder nobody depends on is present, not installed;
// one only the worker or the web depends on is a half-installed state.
const manifestPackages = packages.filter((pkg) => pkg.exports?.['./manifest'] !== undefined);
const apiModules = manifestPackages.filter((pkg) => dependsOn(apiPackage, pkg));
for (const pkg of manifestPackages.filter((pkg) => !apiModules.includes(pkg))) {
  const holders = holdersOf(pkg.name);
  if (holders.length === 0) {
    console.log(`gen-modules: ${pkg.name} present, not installed: pnpm module add ${pkg.dir}`);
    continue;
  }
  missingFromApi(pkg.name, specOf(pkg), holders);
}
for (const name of new Set([...registryNames(workerPackage), ...registryNames(webPackage)])) {
  if (apiPackage.dependencies?.[name] !== undefined) continue;
  missingFromApi(
    name,
    workerPackage.dependencies?.[name] ?? webPackage.dependencies?.[name],
    holdersOf(name),
  );
}

// Copy of the exact-version pattern in scripts/module.mjs; scripts/test/gen-modules.test.mjs pins the two equal.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
// Set by scripts/module.mjs, whose lockfile-only install leaves node_modules behind: skips the installed-version check below.
const INSTALL_MAY_LAG = 'HAIVE_INSTALL_MAY_LAG';
for (const name of apiRegistryNames) {
  const apiSpec = apiPackage.dependencies[name];
  if (workerPackage.dependencies?.[name] === undefined) {
    console.error(
      `gen-modules: ${name} is a dependency of @haive/api but not of @haive/worker; add "${name}": "${apiSpec}" to packages/worker/package.json`,
    );
    process.exit(1);
  }
  const holders = hostsHolding(name);
  const installed = registry.find((pkg) => pkg.name === name)?.version;
  if (
    !EXACT_VERSION.test(apiSpec) ||
    holders.some(({ pkg }) => pkg.dependencies[name] !== apiSpec)
  ) {
    const specs = holders.map(({ host, pkg }) => `${host}: "${pkg.dependencies[name]}"`);
    const found = installed === undefined ? 'not installed' : `installed "${installed}"`;
    console.error(
      `gen-modules: ${name} must be one exact version, the same in every package that depends on it (${specs.join(', ')}; ${found}); change it in ${holders.map(({ file }) => file).join(', ')}`,
    );
    process.exit(1);
  }
  // npm drops build metadata (+...) when it stores a version, and semver ignores it in comparisons.
  const core = (version) => version.split('+')[0];
  if (
    process.env[INSTALL_MAY_LAG] !== '1' &&
    installed !== undefined &&
    core(installed) !== core(apiSpec)
  ) {
    console.error(
      `gen-modules: ${name} is declared as "${apiSpec}" but packages/api/node_modules/${name} is "${installed}", and the generated module lists would come from that old copy; run pnpm install (pnpm docker rebuild on the dev stack)`,
    );
    process.exit(1);
  }
}

const apiImports = apiModules.flatMap((pkg, i) => [
  `import m${i} from '${pkg.name}/manifest';`,
  ...(pkg.exports['./routes'] !== undefined ? [`import r${i} from '${pkg.name}/routes';`] : []),
]);
const apiEntries = apiModules.map((pkg, i) => {
  const routes = pkg.exports['./routes'] !== undefined ? `, routes: r${i}` : '';
  return `  { packageName: '${pkg.name}', source: '${pkg.source}', manifest: m${i}${routes} },`;
});
// A registry with no entry needs no type, and the file then carries no import at all.
const apiBody =
  apiModules.length === 0
    ? `// Generated by scripts/gen-modules.mjs. Do not edit.
export const moduleRegistry = [] as const;
`
    : `// Generated by scripts/gen-modules.mjs. Do not edit.
import type { ApiModuleEntry } from './modules/loader.js';
${apiImports.join('\n')}

export const moduleRegistry: readonly ApiModuleEntry[] = [
${apiEntries.join('\n')}
];
`;

for (const pkg of apiModules) {
  if (idOf(pkg.name) === null) {
    console.error(
      `gen-modules: ${pkg.name} exports ./manifest but is not named @haive/module-<id> or @haive-module/<id> (id = [a-z0-9][a-z0-9-]*, at most 23 characters); the loaders refuse it at boot`,
    );
    process.exit(1);
  }
  if (workerPackage.dependencies?.[pkg.name] === undefined) {
    console.error(
      `gen-modules: ${pkg.name} exports ./manifest but is not a dependency of @haive/worker; add "${pkg.name}": "${specOf(pkg)}" to packages/worker/package.json`,
    );
    process.exit(1);
  }
}

const workerParts = ['steps', 'ensure-schema', 'jobs', 'teardown'];
const workerKeys = {
  steps: 'steps',
  'ensure-schema': 'ensureSchema',
  jobs: 'jobs',
  teardown: 'teardown',
};
const workerImports = apiModules.flatMap((pkg, i) => [
  `import m${i} from '${pkg.name}/manifest';`,
  ...workerParts
    .filter((part) => pkg.exports[`./${part}`] !== undefined)
    .map((part) => `import ${part[0]}${i} from '${pkg.name}/${part}';`),
]);
const workerEntries = apiModules.map((pkg, i) => {
  const parts = workerParts
    .filter((part) => pkg.exports[`./${part}`] !== undefined)
    .map((part) => `, ${workerKeys[part]}: ${part[0]}${i}`)
    .join('');
  return `  { packageName: '${pkg.name}', source: '${pkg.source}', manifest: m${i}${parts} },`;
});
const workerBody =
  apiModules.length === 0
    ? `// Generated by scripts/gen-modules.mjs. Do not edit.
export const moduleRegistry = [] as const;
`
    : `// Generated by scripts/gen-modules.mjs. Do not edit.
import type { WorkerModuleEntry } from './modules/loader.js';
${workerImports.join('\n')}

export const moduleRegistry: readonly WorkerModuleEntry[] = [
${workerEntries.join('\n')}
];
`;

const webModuleFor = (pkg, part) => {
  if (pkg.exports?.['./manifest'] === undefined) {
    console.error(
      `gen-modules: ${pkg.name} exports ${part} but no ./manifest; a module needs a manifest`,
    );
    process.exit(1);
  }
  if (!apiModules.includes(pkg)) return null;
  const id = idOf(pkg.name);
  if (id === null) {
    console.error(
      `gen-modules: ${pkg.name} exports ${part} but is not named @haive/module-<id> or @haive-module/<id> (id = [a-z0-9][a-z0-9-]*, at most 23 characters)`,
    );
    process.exit(1);
  }
  if (webPackage.dependencies?.[pkg.name] === undefined) {
    console.error(
      `gen-modules: ${pkg.name} exports ${part} but is not a dependency of @haive/web; add "${pkg.name}": "${specOf(pkg)}" to packages/web/package.json`,
    );
    process.exit(1);
  }
  return { name: pkg.name, id };
};
const webModules = packages
  .filter((pkg) => pkg.exports?.['./web'] !== undefined)
  .map((pkg) => webModuleFor(pkg, './web'))
  .filter((mod) => mod !== null);
const dashboardModules = packages
  .filter((pkg) => pkg.exports?.['./dashboard'] !== undefined)
  .map((pkg) => webModuleFor(pkg, './dashboard'))
  .filter((mod) => mod !== null);
for (const pkg of apiModules) {
  const hasWebPart = pkg.exports['./web'] !== undefined || pkg.exports['./dashboard'] !== undefined;
  if (!hasWebPart && dependsOn(webPackage, pkg)) {
    console.error(
      `gen-modules: ${pkg.name} is a dependency of @haive/web but exports neither ./web nor ./dashboard; remove "${pkg.name}" from packages/web/package.json`,
    );
    process.exit(1);
  }
}
const webBody =
  webModules.length === 0
    ? `// Generated by scripts/gen-modules.mjs. Do not edit.
export const moduleWebPages = {} as const;
`
    : `// Generated by scripts/gen-modules.mjs. Do not edit.
${webModules.map((mod, i) => `import w${i} from '${mod.name}/web';`).join('\n')}

export const moduleWebPages = {
${webModules.map((mod, i) => `  '${mod.id}': w${i},`).join('\n')}
} as const;
`;

const dashboardBody =
  dashboardModules.length === 0
    ? `// Generated by scripts/gen-modules.mjs. Do not edit.
export const moduleDashboardWidgets = [] as const;
`
    : `// Generated by scripts/gen-modules.mjs. Do not edit.
${dashboardModules.map((mod, i) => `import d${i} from '${mod.name}/dashboard';`).join('\n')}

export const moduleDashboardWidgets = [
${dashboardModules.map((mod, i) => `  ...d${i}.map((widget) => ({ moduleId: '${mod.id}', ...widget })),`).join('\n')}
] as const;
`;

for (const [out, body] of [
  [join(root, 'packages', 'api', 'src', 'modules.generated.ts'), apiBody],
  [join(root, 'packages', 'worker', 'src', 'modules.generated.ts'), workerBody],
  [join(root, 'packages', 'web', 'src', 'generated', 'module-pages.ts'), webBody],
  [join(root, 'packages', 'web', 'src', 'generated', 'module-dashboard.ts'), dashboardBody],
]) {
  let current = null;
  try {
    current = readFileSync(out, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (current === body) continue;
  const createdDir = mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  // The dev containers run this as root on the bind-mounted tree; hand the file back like build-libs.sh.
  if (process.getuid?.() === 0) {
    const { uid, gid } = statSync(root);
    if (createdDir !== undefined) chownSync(createdDir, uid, gid);
    chownSync(out, uid, gid);
  }
}
