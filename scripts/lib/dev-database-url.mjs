import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

// Host tools read the install .env without executing shell code or overwriting CI exports.
export function devDatabaseUrl(envFile = new URL('../../.env', import.meta.url)) {
  let file = {};
  try {
    file = parseEnv(readFileSync(envFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (file.DATABASE_URL) {
    const url = new URL(file.DATABASE_URL);
    if (url.hostname === 'postgres') url.hostname = 'localhost';
    return url.toString();
  }
  const password = env.POSTGRES_PASSWORD || file.POSTGRES_PASSWORD;
  if (!password)
    throw new Error('Set DATABASE_URL or run scripts/dev.sh up to generate .env credentials.');
  const host = env.POSTGRES_HOST || file.POSTGRES_HOST || 'localhost';
  const url = new URL('postgres://localhost');
  url.hostname = host === 'postgres' ? 'localhost' : host;
  url.port = env.POSTGRES_PORT || file.POSTGRES_PORT || '5432';
  url.username = env.POSTGRES_USER || file.POSTGRES_USER || 'haive';
  url.password = password;
  url.pathname = '/' + (env.POSTGRES_DB || file.POSTGRES_DB || 'haive');
  return url.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = new URL(
    process.argv[2] ? devDatabaseUrl() : process.env.PLAYWRIGHT_DATABASE_URL || devDatabaseUrl(),
  );
  // schema-parity's explicit PG_* settings retain their existing CI precedence.
  if (process.argv[2]) {
    if (process.env.PG_USER) url.username = process.env.PG_USER;
    if (process.env.PG_PASSWORD) url.password = process.env.PG_PASSWORD;
    if (process.env.PG_HOST) url.hostname = process.env.PG_HOST;
    if (process.env.PG_PORT) url.port = process.env.PG_PORT;
    url.pathname = '/' + process.argv[2];
  }
  process.stdout.write(url.toString());
}
