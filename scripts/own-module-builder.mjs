#!/usr/bin/env node
// Runs only in the disposable builder / BuildKit stages; never edits the installed source.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE = /^(?:@haive\/module-|@haive-module\/)([a-z0-9][a-z0-9-]{0,22})$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
const HOSTS = ['api', 'worker', 'web'];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const putJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function parsePlan(value) {
  if (
    !value ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)
  )
    throw new Error('version must be a release version');
  for (const [label, ref] of [
    ['builderImage', value.builderImage],
    ...['api', 'worker', ...(value.rebuildWeb ? ['web'] : [])].flatMap((host) => [
      [`baseImages.${host}`, value.baseImages?.[host]],
      [`outputImages.${host}`, value.outputImages?.[host]],
    ]),
  ]) {
    if (typeof ref !== 'string' || !IMAGE.test(ref))
      throw new Error(`${label} must be an image reference`);
  }
  for (const ref of Object.values(value.outputImages)) {
    if (Object.values(value.baseImages).includes(ref) || ref === value.builderImage)
      throw new Error('output image must differ from every base image');
  }
  return { ...value, rebuildWeb: value.rebuildWeb === true };
}

export function prepareModules(root, ids, rebuildWeb) {
  const hosts = Object.fromEntries(
    HOSTS.map((host) => [host, json(join(root, 'packages', host, 'package.json'))]),
  );
  const modules = ids.map((id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,22}$/.test(id)) throw new Error(`invalid module folder ${id}`);
    const pkg = json(join(root, 'modules', id, 'package.json'));
    if (MODULE.exec(pkg.name)?.[1] !== id || pkg.exports?.['./manifest'] === undefined)
      throw new Error(`${id} must be a matching module package exporting ./manifest`);
    if (
      HOSTS.some((host) =>
        Object.keys(hosts[host].dependencies ?? {}).some((name) => MODULE.exec(name)?.[1] === id),
      )
    )
      throw new Error(`${id} collides with a baked module`);
    const web = pkg.exports['./web'] !== undefined || pkg.exports['./dashboard'] !== undefined;
    if (web && !rebuildWeb) throw new Error(`${id} has web parts; set rebuildWeb to build its UI`);
    return { pkg, web };
  });
  // Validate the entire set before writing anything.
  for (const { pkg, web } of modules) {
    for (const host of HOSTS.filter((host) => host !== 'web' || web))
      hosts[host].dependencies[pkg.name] = 'workspace:*';
  }
  for (const host of HOSTS) putJson(join(root, 'packages', host, 'package.json'), hosts[host]);
}

export function buildDockerfile(plan) {
  const hosts = ['api', 'worker', ...(plan.rebuildWeb ? ['web'] : [])];
  const runtime = ['api', 'worker']
    .map(
      (host) => `FROM ${plan.baseImages[host]} AS ${host}
COPY --from=own /app/node_modules ./node_modules
COPY --from=own /app/modules ./modules
COPY --from=own /app/packages/${host}/package.json ./packages/${host}/
COPY --from=own /app/packages/${host}/dist ./packages/${host}/dist
COPY --from=own /app/packages/${host}/node_modules ./packages/${host}/node_modules
`,
    )
    .join('\n');
  return `FROM ${plan.builderImage} AS own
WORKDIR /app
COPY own-modules /own-modules
RUN node scripts/own-module-builder.mjs --prepare ${plan.rebuildWeb ? '--web' : ''}
RUN pnpm install --prefer-offline --no-frozen-lockfile
RUN pnpm --filter './modules/*' build && ${hosts.map((host) => `pnpm --filter @haive/${host} build`).join(' && ')}
${runtime}${
    plan.rebuildWeb
      ? `
FROM ${plan.baseImages.web} AS web
COPY --from=own /app/packages/web/public ./packages/web/public
COPY --from=own /app/packages/web/.next/standalone ./
COPY --from=own /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=own /app/packages/web/src/generated/modules.json ./packages/web/modules.generated.json
`
      : ''
  }`;
}

function runDocker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit', timeout: 1_800_000 });
  if (result.status !== 0) throw new Error(`docker failed (${result.signal ?? result.status})`);
}

export function snapshotModules(source, destination) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      String.raw`
import fcntl, os, re, shutil, sys
source, destination = sys.argv[1:]
fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    fcntl.flock(fd, fcntl.LOCK_SH)
    staging = re.compile(r'^\.[a-z0-9][a-z0-9-]{0,22}\.tmp-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
    shutil.copytree(source, destination, symlinks=True,
        ignore=lambda path, names: [name for name in names if path == source and staging.fullmatch(name)])
finally:
    os.close(fd)
`,
      source,
      destination,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (result.status !== 0)
    throw new Error(
      `own-module snapshot failed: ${result.stderr || result.error?.message || result.signal}`,
    );
}

export function main() {
  if (process.argv.includes('--prepare')) {
    const ids = readdirSync('/own-modules');
    for (const id of ids) {
      if (!/^[a-z0-9][a-z0-9-]{0,22}$/.test(id)) throw new Error(`invalid module folder ${id}`);
      if (existsSync(join('/app/modules', id)))
        throw new Error(`${id} collides with a baked folder`);
    }
    for (const id of ids)
      cpSync(join('/own-modules', id), join('/app/modules', id), { recursive: true });
    prepareModules('/app', ids, process.argv.includes('--web'));
    return;
  }
  const plan = parsePlan(JSON.parse(process.env.HAIVE_BUILD_PLAN ?? 'null'));
  if (process.env.HAIVE_VERSION !== plan.version)
    throw new Error('builder version does not match target release');
  const source = '/input';
  if (readdirSync(source).length === 0) throw new Error('own-module directory is empty');
  const dir = mkdtempSync(join(tmpdir(), 'haive-own-build-'));
  try {
    snapshotModules(source, join(dir, 'own-modules'));
    writeFileSync(
      join(dir, '.dockerignore'),
      '**/node_modules\n**/.git\n**/.npmrc\n**/.env\n**/.env.*\n',
    );
    writeFileSync(join(dir, 'Dockerfile'), buildDockerfile(plan));
    for (const host of ['api', 'worker', ...(plan.rebuildWeb ? ['web'] : [])]) {
      runDocker(['build', '--target', host, '-t', plan.outputImages[host], dir]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`own-module-builder: ${error.message}\n`);
    process.exitCode = 1;
  }
}
