// Pure helpers for scripts/run-gated-tests.mjs. The "Postgres-gated tests" job in ci.yml is the
// only source of the row list, the images and the env; nothing here holds a second copy.
import { readWorkflow } from '../test/workflow.mjs';

const SERVERS = new Set(['pg', 'pgvector']);
const DB_NAME = /^[a-z_][a-z0-9_]*$/;
const LIST = /<<'GATED'\n([\s\S]+?)\nGATED(?:\n|$)/;
const URL_PROTOCOLS = new Set(['postgres:', 'postgresql:', 'redis:', 'rediss:']);

export function parseRows(list) {
  const rows = [];
  for (const line of list.split('\n')) {
    if (line.trim() === '') continue;
    const columns = line.split(' ');
    if (columns.length !== 5 || columns.some((column) => !/^\S+$/.test(column))) {
      throw new Error(`malformed GATED row: "${line}"`);
    }
    const [pkg, file, variable, db, server] = columns;
    if (!SERVERS.has(server) || !DB_NAME.test(db)) {
      throw new Error(`malformed GATED row: "${line}"`);
    }
    rows.push({ pkg, file, var: variable, db, server });
  }
  return rows;
}

const withoutExpressions = (env) =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter(([, value]) => !String(value).includes('${{')),
  );

export function readGated(workflow = readWorkflow('ci.yml')) {
  const job = workflow.jobs?.['postgres-gated'];
  if (!job) throw new Error('ci.yml has no job "postgres-gated"');
  const step = (job.steps ?? []).find((candidate) => LIST.test(candidate.run ?? ''));
  if (!step) throw new Error('job "postgres-gated" has no step with a <<\'GATED\' list');
  const services = {};
  for (const [name, service] of Object.entries(job.services ?? {})) {
    const ports = (service.ports ?? []).map((port) => String(port).split(':'));
    services[name] = {
      image: service.image,
      env: service.env ?? {},
      hostPorts: ports.map((parts) => Number(parts[0])),
      containerPort: Number(ports[0]?.at(-1)),
    };
  }
  return {
    rows: parseRows(LIST.exec(step.run)[1]),
    services,
    jobEnv: withoutExpressions(job.env),
    stepEnv: withoutExpressions(step.env),
  };
}

export function selectRows(rows, selectors) {
  if (selectors.length === 0) throw new Error('no selection given');
  const matches = (row, selector) =>
    selector === 'all' ||
    selector === row.pkg ||
    selector === row.file ||
    selector === `${row.pkg}/${row.file}` ||
    selector === `packages/${row.pkg}/${row.file}`;
  const unknown = selectors.filter((selector) => !rows.some((row) => matches(row, selector)));
  if (unknown.length > 0) throw new Error(`unknown selection: ${unknown.join(', ')}`);
  const seen = new Set();
  return rows.filter((row) => {
    if (!selectors.some((selector) => matches(row, selector))) return false;
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A store URL is mapped by its port (an omitted port is the protocol's default) to the declared
// service that owns it: rewritten when that service is running, dropped otherwise, and dropped
// when no declared service owns the port. A store URL is never copied through.
const STORE_URL = /^(postgres|postgresql|redis|rediss):/i;
const DEFAULT_PORTS = { 'postgres:': 5432, 'postgresql:': 5432, 'redis:': 6379, 'rediss:': 6379 };

export function rewriteEnv(env, declared, running) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    let url = null;
    try {
      url = new URL(value);
    } catch {
      if (STORE_URL.test(value)) continue; // a store URL that cannot be read is not copied
    }
    if (!url || !URL_PROTOCOLS.has(url.protocol)) {
      out[name] = value;
      continue;
    }
    const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port);
    const service = Object.keys(declared).find((key) => declared[key].hostPorts.includes(port));
    const target = service && running[service];
    if (!target) continue; // never leave a URL to a service this run does not own
    url.hostname = '127.0.0.1';
    url.port = String(target.port);
    if (url.protocol.startsWith('postgres') && target.user !== undefined) {
      url.username = target.user;
      url.password = target.password;
    }
    out[name] = url.toString();
  }
  return out;
}

export function completeness(report) {
  const passed = report.numPassedTests;
  const pending = report.numPendingTests;
  const todo = report.numTodoTests;
  return {
    // The negation of CI's failure test, `!(passed > 0) || pending > 0 || todo > 0`.
    ok: passed > 0 && !(pending > 0) && !(todo > 0),
    line: `passed=${passed} failed=${report.numFailedTests} skipped=${pending} todo=${todo}`,
  };
}

// True when the test file names a step-env variable whose value is a Redis URL.
export function needsRedis(stepEnv, text) {
  return Object.entries(stepEnv).some(
    ([name, value]) => /^rediss?:\/\//.test(value) && text.includes(name),
  );
}
