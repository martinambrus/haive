// Reads `docker compose ... config --format json`, rendered with HAIVE_NPMRC=<file>, from stdin.
//   node check-compose.mjs <file> secrets|mount
// The dev stack builds `target: deps` for api, worker, web and dev-libs, and each of those runs
// `pnpm install`, so each needs the npmrc build secret (`secrets`); db-migrate runs `pnpm install`
// at runtime on the host tree, so it needs the same file mounted read-only where pnpm looks for it,
// as a bind volume or as a service secret with a target (`mount`). Prints one line per problem;
// exits 1 when there is any.
import { readFileSync } from 'node:fs';

const [file, mode] = process.argv.slice(2);
const config = JSON.parse(readFileSync(0, 'utf8'));
const problems = [];

const secretId = (entry) =>
  typeof entry === 'string' ? entry : (entry.target ?? entry.source ?? null);
const secretSource = (entry) => (typeof entry === 'string' ? entry : entry.source);

if (mode === 'secrets') {
  for (const name of ['api', 'worker', 'web', 'dev-libs']) {
    const entries = config.services?.[name]?.build?.secrets ?? [];
    const entry = entries.find((candidate) => secretId(candidate) === 'npmrc');
    if (entry === undefined) {
      problems.push(`${name}: build.secrets has no secret with the id npmrc`);
      continue;
    }
    const definition = config.secrets?.[secretSource(entry)];
    if (definition?.file !== file && definition?.environment !== 'HAIVE_NPMRC') {
      problems.push(
        `${name}: the npmrc secret does not come from HAIVE_NPMRC (${JSON.stringify(definition)})`,
      );
    }
  }
} else if (mode === 'mount') {
  const migrate = config.services?.['db-migrate'];
  const env = migrate?.environment ?? {};
  const userConfig = env.NPM_CONFIG_USERCONFIG ?? env.npm_config_userconfig;
  const readByPnpm = (target) =>
    target === '/root/.npmrc' || (userConfig !== undefined && target === userConfig);
  const mount = (migrate?.volumes ?? []).find((volume) => volume.source === file);
  const secret = (migrate?.secrets ?? []).find((entry) => {
    const definition = config.secrets?.[secretSource(entry)];
    return definition?.file === file || definition?.environment === 'HAIVE_NPMRC';
  });
  if (mount !== undefined) {
    if (mount.read_only !== true)
      problems.push('db-migrate: the HAIVE_NPMRC mount is not read-only');
    if (!readByPnpm(mount.target)) {
      problems.push(
        `db-migrate: HAIVE_NPMRC is mounted at ${mount.target}, where pnpm does not read it (it reads /root/.npmrc or NPM_CONFIG_USERCONFIG)`,
      );
    }
  } else if (secret !== undefined) {
    const target = typeof secret === 'string' ? undefined : secret.target;
    if (!readByPnpm(target)) {
      problems.push(
        `db-migrate: the HAIVE_NPMRC secret is mounted at ${target ?? '/run/secrets/<name>'}, where pnpm does not read it (it reads /root/.npmrc or NPM_CONFIG_USERCONFIG)`,
      );
    }
  } else {
    problems.push('db-migrate: neither a volume nor a service secret carries HAIVE_NPMRC');
  }
} else {
  console.error('usage: node check-compose.mjs <file> secrets|mount');
  process.exit(2);
}

for (const problem of problems) console.log(problem);
process.exit(problems.length === 0 ? 0 : 1);
