#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatOffender, idOf, parseExpect } from './channel-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE =
  'usage: node scripts/channel-boot-check.mjs --record <build-record.json> [--timeout-ms <1..600000; default 180000 per boot stage>]';
const POSTGRES = 'pgvector/pgvector:pg18';
const REDIS = 'redis:8.4-alpine';
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const lastLines = (text) =>
  String(text ?? '')
    .trim()
    .split('\n')
    .slice(-20)
    .join('\n')
    .slice(-8000);

export function parseRecord(text) {
  const doc = JSON.parse(text);
  if (!doc || ![1, 2].includes(doc.schema)) throw new Error('record must have schema 1 or 2');
  if (
    typeof doc.channel !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(doc.channel)
  )
    throw new Error('record has an invalid channel');
  if (
    typeof doc.version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(doc.version) ||
    doc.tag !== `v${doc.version}`
  )
    throw new Error('record tag/version must name the same final release');
  if (typeof doc.commit !== 'string' || !/^[a-f0-9]{40}$/.test(doc.commit))
    throw new Error('record has an invalid commit');
  if (!['linux/amd64', 'linux/arm64'].includes(doc.platform))
    throw new Error('record has an invalid platform');
  if (!doc.imageStore || typeof doc.imageStore.Driver !== 'string')
    throw new Error('record has no image store');
  const refs = {};
  for (const key of [
    'api',
    'worker',
    'web',
    ...(doc.schema === 2 || doc.images?.builder !== undefined ? ['builder'] : []),
  ]) {
    const image = doc.images?.[key];
    if (
      !image ||
      typeof image.ref !== 'string' ||
      typeof image.id !== 'string' ||
      !IMAGE_ID.test(image.id) ||
      typeof image.built !== 'boolean'
    )
      throw new Error(`record images.${key} needs a recorded id and built flag`);
    refs[key] = image.ref;
  }
  const expectation = parseExpect(
    JSON.stringify({ version: doc.version, images: refs, modules: doc.modules }),
  );
  return { ...doc, entitled: expectation.modules.map((m) => m.id).sort() };
}

function capture(command, args, { timeout, signal, ...options }) {
  return new Promise((resolveResult) => {
    const stdout = [];
    const stderr = [];
    let error;
    let bytes = 0;
    let forceTimer;
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (cause) => {
      error ??= cause;
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const abort = () => stop(new Error('interrupted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error('command timed out')), timeout);
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop(new Error('command output exceeded 2 MiB'));
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (cause) => {
      error = cause;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolveResult({
        status,
        error,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function readModules(half, key) {
  if (!half || !Array.isArray(half.modules)) throw new Error(`malformed ${key} loaded report`);
  const ids = half.modules.map((m) => {
    if (!m || typeof m.id !== 'string' || idOf(`@haive-module/${m.id}`) !== m.id)
      throw new Error(`malformed ${key} module id`);
    return m.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${key} module id`);
  return new Set(ids);
}

export async function run(
  argv,
  {
    runner = capture,
    request = fetch,
    say = (line) => process.stdout.write(`${line}\n`),
    env = process.env,
    root = ROOT,
    signal,
    now = Date.now,
    wait = (ms) => delay(ms, undefined, { signal }),
  } = {},
) {
  let scratch;
  let status = 2;
  let timeout = 180_000;
  const secrets = [];
  const resources = [];
  const pulledImages = [];
  const containers = [];
  const emit = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('[secret]');
    say(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?'));
  };
  const interrupted = () => {
    if (signal?.aborted) throw new Error('interrupted');
  };
  const docker = async (args, { cleanup = false, allowFailure = false } = {}) => {
    if (!cleanup) interrupted();
    const result = await runner('docker', args, {
      cwd: root,
      env,
      timeout: cleanup ? 15_000 : Math.min(timeout, 30_000),
      signal: cleanup ? undefined : signal,
    });
    if (!allowFailure && (result.status !== 0 || result.error))
      throw new Error(
        `docker ${args[0]} ${args.at(-1)} failed (${result.status ?? 'no exit code'}): ${result.error?.message ?? lastLines(result.stderr)}`,
      );
    return result;
  };
  const create = async (kind, name, args) => {
    const register = () => {
      resources.push({ kind, name });
      if (kind === 'container') containers.push(name);
    };
    try {
      await docker(args);
      register();
    } catch (error) {
      const existing = await docker([kind, 'inspect', name], {
        cleanup: true,
        allowFailure: true,
      });
      if (signal?.aborted || (existing.status === 0 && !existing.error)) register();
      throw error;
    }
  };
  const poll = async (name, probe) => {
    const deadline = now() + timeout;
    do {
      interrupted();
      const result = await probe();
      if (result !== undefined && result !== false) return result;
      if (now() >= deadline) break;
      await wait(Math.min(1000, Math.max(1, deadline - now())));
    } while (now() <= deadline);
    throw new Error(`timed out waiting for ${name}`);
  };
  const state = async (name) =>
    JSON.parse((await docker(['inspect', '--format', '{{json .State}}', name])).stdout);
  const running = async (name) => {
    const current = await state(name);
    if (!current.Running)
      throw new Error(`${name} stopped (${current.Status}, exit ${current.ExitCode})`);
  };
  const http = async (url, options = {}) => {
    interrupted();
    const bounded = AbortSignal.timeout(Math.min(timeout, 5000));
    return request(url, {
      ...options,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, bounded]) : bounded,
    });
  };
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        record: { type: 'string', multiple: true },
        'timeout-ms': { type: 'string', multiple: true },
      },
      allowPositionals: false,
    });
    if (values.record?.length !== 1 || values['timeout-ms']?.length > 1)
      throw new Error(`exactly one --record is required\n${USAGE}`);
    if (values['timeout-ms']) {
      const value = values['timeout-ms'][0];
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600_000)
        throw new Error(`invalid --timeout-ms\n${USAGE}`);
      timeout = Number(value);
    }
    const record = parseRecord(readFileSync(values.record[0], 'utf8'));
    for (const key of ['api', 'worker']) {
      const image = record.images[key];
      const actual = (
        await docker(['image', 'inspect', '--format', '{{.Id}}', image.ref])
      ).stdout.trim();
      if (actual !== image.id)
        throw new Error(`${key} ${image.ref} no longer resolves to recorded id ${image.id}`);
    }
    const tempBase = realpathSync(tmpdir());
    const rel = relative(realpathSync(root), tempBase);
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
      throw new Error('TMPDIR must be outside the repository');
    const prefix = `hbc-${record.channel}-${randomBytes(6).toString('hex')}`;
    scratch = mkdtempSync(join(tempBase, `${prefix}-`));
    const secret = () => {
      const value = randomBytes(32).toString('hex');
      secrets.push(value);
      return value;
    };
    const dbPassword = secret();
    const encryptionKey = secret();
    const adminPassword = secret();
    const setupToken = secret();
    const pgFile = join(scratch, 'postgres.env');
    const appFile = join(scratch, 'app.env');
    writeFileSync(
      pgFile,
      `POSTGRES_USER=bootcheck\nPOSTGRES_DB=bootcheck\nPOSTGRES_PASSWORD=${dbPassword}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    writeFileSync(
      appFile,
      `DATABASE_URL=postgres://bootcheck:${dbPassword}@${prefix}-postgres:5432/bootcheck\nREDIS_URL=redis://${prefix}-redis:6379\nCONFIG_ENCRYPTION_KEY=${encryptionKey}\nSETUP_TOKEN=${setupToken}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    for (const image of [POSTGRES, REDIS]) {
      const found = await docker(['image', 'inspect', '--format', '{{.Id}}', image], {
        allowFailure: true,
      });
      if (found.status !== 0 || found.error) {
        const listed = await docker(['image', 'ls', '-q', image]);
        if (
          found.error ||
          found.status !== 1 ||
          !/No such image/i.test(found.stderr ?? '') ||
          listed.stdout.trim() !== ''
        )
          throw new Error(`could not inspect dependency image ${image}`);
        await docker(['pull', image]);
        pulledImages.push({ kind: 'image', name: image });
      }
    }
    await create('network', prefix, [
      'network',
      'create',
      '--label',
      `haive.boot-check=${prefix}`,
      prefix,
    ]);
    for (const suffix of ['postgres-data', 'redis-data']) {
      const name = `${prefix}-${suffix}`;
      await create('volume', name, [
        'volume',
        'create',
        '--label',
        `haive.boot-check=${prefix}`,
        name,
      ]);
    }
    const start = async (suffix, args) => {
      const name = `${prefix}-${suffix}`;
      await create('container', name, [
        'run',
        '-d',
        '--label',
        `haive.boot-check=${prefix}`,
        '--name',
        name,
        '--network',
        prefix,
        ...args,
      ]);
      emit(`channel-boot-check: started ${name}`);
      return name;
    };
    const pg = await start('postgres', [
      '--env-file',
      pgFile,
      '--mount',
      `type=volume,src=${prefix}-postgres-data,dst=/var/lib/postgresql`,
      POSTGRES,
    ]);
    const redis = await start('redis', [
      '--mount',
      `type=volume,src=${prefix}-redis-data,dst=/data`,
      REDIS,
      'redis-server',
      '--maxmemory',
      '256mb',
      '--maxmemory-policy',
      'noeviction',
    ]);
    await poll(pg, async () => {
      await running(pg);
      return (
        (
          await docker(
            ['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootcheck', '-d', 'bootcheck'],
            { allowFailure: true },
          )
        ).status === 0
      );
    });
    await poll(redis, async () => {
      await running(redis);
      return (
        (
          await docker(['exec', redis, 'redis-cli', 'ping'], { allowFailure: true })
        ).stdout?.trim() === 'PONG'
      );
    });
    const appArgs = (key) => [
      '--pull',
      'never',
      '--platform',
      record.platform,
      '--env-file',
      appFile,
      record.images[key].id,
    ];
    const migrate = await start('migrate', [
      ...appArgs('api'),
      'node',
      'packages/database/dist/migrate/index.js',
    ]);
    await poll(migrate, async () => {
      const current = await state(migrate);
      if (current.Running) return false;
      if (current.Status !== 'exited' || current.ExitCode !== 0)
        throw new Error(`${migrate} failed (${current.Status}, exit ${current.ExitCode})`);
      return true;
    });
    const api = await start('api', ['-p', '127.0.0.1::3001', ...appArgs('api')]);
    const worker = await start('worker', appArgs('worker'));
    const binding = (await docker(['port', api, '3001/tcp'])).stdout.trim();
    if (!/^127\.0\.0\.1:\d+$/.test(binding))
      throw new Error(`${api} has an unexpected port binding`);
    const base = `http://${binding}`;
    await poll(api, async () => {
      await running(api);
      await running(worker);
      try {
        return (await http(`${base}/health`)).ok;
      } catch {
        interrupted();
        return false;
      }
    });
    const registration = await http(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bootcheck@example.test',
        password: adminPassword,
        setupToken,
      }),
    });
    if (registration.status !== 201)
      throw new Error(`${api} bootstrap registration failed (HTTP ${registration.status})`);
    const account = await registration.json();
    if (account?.user?.role !== 'admin') throw new Error(`${api} bootstrap account is not admin`);
    const cookies = registration.headers.getSetCookie().map((line) => line.split(';')[0]);
    for (const cookie of cookies) {
      const value = cookie.slice(cookie.indexOf('=') + 1);
      if (value) secrets.push(value);
    }
    if (!cookies.some((cookie) => cookie.startsWith('haive_access=')))
      throw new Error(`${api} registration returned no session cookie`);
    const report = await poll(`${worker} module report`, async () => {
      await running(api);
      await running(worker);
      let response;
      try {
        response = await http(`${base}/modules/loaded`, {
          headers: { Cookie: cookies.join('; ') },
        });
      } catch {
        interrupted();
        return false;
      }
      if (!response.ok) throw new Error(`${api} /modules/loaded failed (HTTP ${response.status})`);
      const body = await response.json();
      if (body.worker === null) return false;
      readModules(body.api, 'api');
      readModules(body.worker, 'worker');
      return body;
    });
    let offenders = 0;
    for (const key of ['api', 'worker']) {
      const actual = readModules(report[key], key);
      const expected = new Set(record.entitled);
      for (const [direction, ids] of [
        ['extra', [...actual].filter((id) => !expected.has(id))],
        ['missing', [...expected].filter((id) => !actual.has(id))],
      ]) {
        for (const id of ids.sort()) {
          emit(formatOffender({ key, check: 'loaded', what: `${direction} ${id}` }));
          offenders++;
        }
      }
      emit(`channel-boot-check: ${key} loaded [${[...actual].sort().join(', ')}]`);
    }
    status = offenders ? 1 : 0;
  } catch (error) {
    emit(`channel-boot-check: could not check: ${error.message}`);
    for (const name of containers) {
      try {
        const result = await docker(['logs', '--tail', '20', name], {
          cleanup: true,
          allowFailure: true,
        });
        emit(
          `channel-boot-check: last logs ${name}\n${lastLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)}`,
        );
      } catch (cause) {
        emit(`channel-boot-check: could not read logs ${name}: ${cause.message}`);
      }
    }
  } finally {
    for (const { kind, name } of [...pulledImages, ...resources].reverse()) {
      try {
        await docker(kind === 'container' ? ['rm', '-f', '-v', name] : [kind, 'rm', name], {
          cleanup: true,
        });
        emit(`channel-boot-check: removed ${kind} ${name}`);
      } catch (error) {
        status = 2;
        const existing = await docker([kind, 'inspect', name], {
          cleanup: true,
          allowFailure: true,
        });
        if (existing.status === 0 && !existing.error)
          emit(`channel-boot-check: cleanup failed; leftover ${kind} ${name}: ${error.message}`);
        else emit(`channel-boot-check: cleanup failed for ${kind} ${name}: ${error.message}`);
      }
    }
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        status = 2;
        emit(`channel-boot-check: cleanup failed; leftover path ${scratch}: ${error.message}`);
      }
    }
  }
  if (signal?.aborted) status = 2;
  emit(
    `channel-boot-check: ${status === 0 ? 'passed' : status === 1 ? 'mismatch' : 'could not check'} (exit ${status})`,
  );
  return status;
}

function isEntryPoint() {
  try {
    return (
      process.argv[1] !== undefined &&
      pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => controller.abort());
  process.exitCode = await run(process.argv.slice(2), { signal: controller.signal });
}
