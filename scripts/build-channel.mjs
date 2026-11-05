#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { idOf, parseExpect, parseToken } from './channel-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_REGISTRY = 'ghcr.io/martinambrus';
const USAGE =
  'usage: node scripts/build-channel.mjs --tag vX.Y.Z --channel <name> --modules <file.json> --token-file <file> [--registry <output-prefix>] [--source-registry <stock-prefix>] [--out <dir>] [--replace]';
const FINAL = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXACT =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANNEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const PREFIX = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const put = (file, data) =>
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });

export function parseModules(value) {
  if (!Array.isArray(value))
    throw new Error('modules must be a JSON array of exact package specifications');
  const ids = new Set();
  return value.map((spec) => {
    if (typeof spec !== 'string')
      throw new Error('each module must be an exact package specification');
    const at = spec.lastIndexOf('@');
    const packageName = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const id = idOf(packageName);
    const match = EXACT.exec(version);
    if (
      !packageName.startsWith('@haive-module/') ||
      id === null ||
      match === null ||
      match[4]?.split('.').some((part) => /^0\d+$/.test(part))
    ) {
      throw new Error('each module must be @haive-module/<id>@<exact-version>');
    }
    if (ids.has(id)) throw new Error('two entitlements have the same module id');
    ids.add(id);
    return { packageName, source: 'registry', version, webParts: [] };
  });
}

function capture(command, args, options) {
  return new Promise((resolveResult) => {
    const { onOutput, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let error;
    const collect = (chunks) => (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        error = new Error('command output exceeded 32 MiB');
        child.kill('SIGTERM');
      } else chunks.push(chunk);
    };
    if (onOutput) {
      for (const [name, stream] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => onOutput(chunk, name));
      }
    } else {
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
    }
    child.on('error', (cause) => {
      error = cause;
    });
    child.on('close', (status) =>
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error,
      }),
    );
  });
}

function privateNpmrc(tree, token) {
  const scope =
    /^@haive-module:registry\s*=\s*(\S+)\s*$/m.exec(
      readFileSync(join(tree, '.npmrc'), 'utf8'),
    )?.[1] ?? 'https://npm.pkg.github.com/';
  const url = new URL(scope);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'the module registry must be an HTTPS URL without credentials or query parameters',
    );
  }
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `@haive-module:registry=${url.origin}${path}\n//${url.host}${path}:_authToken=${token}\n`;
}

export async function run(
  argv,
  {
    root = ROOT,
    runner = capture,
    env = process.env,
    say = (line) => process.stdout.write(`${line}\n`),
    signal,
  } = {},
) {
  let scratch;
  let token;
  const retainedImages = [];
  const scrub = (text) => (token ? String(text).split(token).join('[token]') : String(text));
  const emit = (text) => {
    if (text) say(scrub(text).trimEnd());
  };
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        tag: { type: 'string', multiple: true },
        channel: { type: 'string', multiple: true },
        modules: { type: 'string', multiple: true },
        'token-file': { type: 'string', multiple: true },
        registry: { type: 'string', multiple: true },
        'source-registry': { type: 'string', multiple: true },
        out: { type: 'string', multiple: true },
        replace: { type: 'boolean' },
      },
      allowPositionals: false,
    });
    for (const key of ['tag', 'channel', 'modules', 'token-file']) {
      if (values[key]?.length !== 1) throw new Error(`exactly one --${key} is required\n${USAGE}`);
    }
    for (const key of ['registry', 'source-registry', 'out']) {
      if (values[key]?.length > 1) throw new Error(`only one --${key} is allowed`);
    }
    const tag = values.tag[0];
    const channel = values.channel[0];
    const registry = values.registry?.[0] ?? PUBLIC_REGISTRY;
    const sourceRegistry = values['source-registry']?.[0] ?? env.HAIVE_REGISTRY ?? PUBLIC_REGISTRY;
    const out = resolve(values.out?.[0] ?? `channel-build-${channel}`);
    if (!FINAL.test(tag) || tag.length > 129)
      throw new Error('tag must be a final release tag vX.Y.Z');
    if (!CHANNEL.test(channel))
      throw new Error(
        'channel must be 1–32 lowercase letters, digits or dashes, starting and ending with a letter or digit',
      );
    for (const [flag, prefix] of [
      ['registry', registry],
      ['source-registry', sourceRegistry],
    ]) {
      if (!PREFIX.test(prefix))
        throw new Error(
          `${flag} must be a lowercase image repository prefix without a scheme or tag`,
        );
    }
    const modules = parseModules(json(values.modules[0]));
    token = parseToken(readFileSync(values['token-file'][0], 'utf8'));
    const childEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) =>
          value !== undefined && !key.includes(token) && !String(value).includes(token),
      ),
    );
    const command = async (
      cmd,
      args,
      { cwd = root, quiet = false, allowFailure = false, stream = false, ...options } = {},
    ) => {
      if (signal?.aborted) throw new Error('interrupted');
      const buffers = new Map();
      const onOutput = (chunk, name = 'stdout') => {
        const text = scrub((buffers.get(name) ?? '') + chunk);
        let keep = Math.min(text.length, token.length - 1);
        while (keep > 0 && !text.endsWith(token.slice(0, keep))) keep--;
        buffers.set(name, keep ? text.slice(-keep) : '');
        emit(keep ? text.slice(0, -keep) : text);
      };
      let result;
      try {
        result = await runner(cmd, args, {
          cwd,
          env: childEnv,
          timeout: 1_800_000,
          signal,
          ...options,
          ...(stream ? { onOutput } : {}),
        });
      } finally {
        for (const text of buffers.values()) emit(text);
      }
      if (!quiet) {
        emit(result.stdout);
        emit(result.stderr);
      }
      if (!allowFailure && (result.status !== 0 || result.error)) {
        if (quiet) {
          emit(result.stdout);
          emit(result.stderr);
        }
        throw new Error(
          `${cmd} failed (${result.status ?? 'no exit code'})${result.error ? `: ${result.error.message}` : ''}`,
        );
      }
      return result;
    };
    const version = tag.slice(1);
    const platform = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
    const resolved = await command(
      'git',
      ['-C', root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`],
      { quiet: true },
    );
    const commit = resolved.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      throw new Error('tag did not resolve to a commit');
    const gateStatus = await command(
      'git',
      [
        '-C',
        root,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        'scripts/channel-gate.mjs',
        'scripts/smoke/scan-image.sh',
      ],
      { quiet: true },
    );
    if (gateStatus.stdout.trim())
      throw new Error(
        'gate tooling is dirty: scripts/channel-gate.mjs or scripts/smoke/scan-image.sh',
      );
    const tempBase = realpathSync(tmpdir());
    const rel = relative(realpathSync(root), tempBase);
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
      throw new Error('temporary directory must be outside the repository');
    scratch = mkdtempSync(join(tempBase, 'haive-build-channel-'));
    const tree = join(scratch, 'tree');
    mkdirSync(tree);
    const archive = join(scratch, 'base.tar');
    await command('git', ['-C', root, 'archive', '--format=tar', `--output=${archive}`, commit], {
      quiet: true,
    });
    await command('tar', ['-xf', archive, '-C', tree], { quiet: true });
    rmSync(archive);
    for (const file of [
      'scripts/module.mjs',
      'scripts/gen-modules.mjs',
      'scripts/own-module-builder.mjs',
      'docker/own-module-builder/Dockerfile',
      ...['api', 'worker', 'web'].map((host) => `packages/${host}/Dockerfile`),
    ]) {
      let content;
      try {
        content = readFileSync(join(tree, file), 'utf8');
      } catch {
        throw new Error(`preflight ${tag}: missing ${file}`);
      }
      if (
        file.endsWith('/Dockerfile') &&
        ![...content.matchAll(/--mount=([^\s\\]+)/g)].some((match) => {
          const fields = match[1].split(',');
          return fields.includes('type=secret') && fields.includes('id=npmrc');
        })
      )
        throw new Error(`preflight ${tag}: ${file} lacks an id=npmrc secret mount`);
    }
    for (const entry of readdirSync(join(tree, 'modules'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let pkg;
      try {
        pkg = json(join(tree, 'modules', entry.name, 'package.json'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (typeof pkg.name !== 'string' || idOf(pkg.name) === null)
        throw new Error(`invalid local module package name in modules/${entry.name}/package.json`);
      modules.push({
        packageName: pkg.name,
        source: 'local',
        webParts: ['dashboard', 'web'].filter((part) => pkg.exports?.[`./${part}`] !== undefined),
      });
    }
    const npmrc = join(scratch, 'npmrc');
    writeFileSync(npmrc, privateNpmrc(tree, token), { mode: 0o600, flag: 'wx' });
    const tokenFile = join(scratch, 'token');
    writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
    const outputImage = (host) => `${registry}/haive-${channel}-${host}:${version}`;
    const checkTags = async (hosts) => {
      for (const host of hosts) {
        const found = await command(
          'docker',
          ['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${outputImage(host)}`],
          { quiet: true },
        );
        if (found.stdout.trim() && !values.replace)
          throw new Error(
            `local tag ${outputImage(host)} already exists; use --replace to overwrite`,
          );
      }
    };
    await checkTags(['api', 'worker', 'builder']);
    const moduleEnv = {
      ...childEnv,
      NPM_CONFIG_USERCONFIG: npmrc,
      XDG_CACHE_HOME: join(scratch, 'cache'),
      CI: 'true',
    };
    for (const module of modules.filter((module) => module.source === 'registry')) {
      const spec = `${module.packageName}@${module.version}`;
      const metadata = await command('pnpm', ['view', spec, 'exports', '--json'], {
        cwd: tree,
        env: moduleEnv,
        quiet: true,
      });
      if (!metadata.stdout.trim()) throw new Error(`pnpm view returned no exports for ${spec}`);
      const exports = JSON.parse(metadata.stdout);
      if (!exports || exports['./manifest'] === undefined)
        throw new Error('an entitled package does not export ./manifest');
      module.webParts = ['dashboard', 'web'].filter((part) => exports[`./${part}`] !== undefined);
    }
    const rebuildWeb = modules.some(
      (module) => module.source === 'registry' && module.webParts.length > 0,
    );
    const hosts = ['api', 'worker', 'builder', ...(rebuildWeb ? ['web'] : [])];
    const images = Object.fromEntries(hosts.map((host) => [host, outputImage(host)]));
    if (!rebuildWeb) images.web = `${sourceRegistry}/haive-web:${version}`;
    if (rebuildWeb) await checkTags(['web']);
    mkdirSync(out, { recursive: true });
    rmSync(join(out, 'build-record.json'), { force: true });
    const probe = join(out, `.write-probe-${process.pid}`);
    try {
      writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    } finally {
      rmSync(probe, { force: true });
    }
    const expectation = { version, images, modules };
    parseExpect(JSON.stringify(expectation));
    const expectFile = join(scratch, 'expect.json');
    put(expectFile, expectation);
    for (const module of modules.filter((module) => module.source === 'registry')) {
      const spec = `${module.packageName}@${module.version}`;
      await command(process.execPath, [join(tree, 'scripts', 'module.mjs'), 'add', spec], {
        cwd: tree,
        env: moduleEnv,
      });
    }
    const store = JSON.parse(
      (await command('docker', ['info', '--format', '{{json .}}'], { quiet: true })).stdout,
    );
    const imageStore = { Driver: store.Driver, DriverStatus: store.DriverStatus };
    for (const host of hosts) {
      emit(`build-channel: building ${images[host]} from ${tag} (${commit})`);
      await command(
        'docker',
        [
          'buildx',
          'build',
          '--platform',
          platform,
          '--load',
          '--target',
          'production',
          '--secret',
          `id=npmrc,src=${npmrc}`,
          '--build-arg',
          `HAIVE_VERSION=${version}`,
          '--file',
          host === 'builder'
            ? join(tree, 'docker', 'own-module-builder', 'Dockerfile')
            : join(tree, 'packages', host, 'Dockerfile'),
          '--tag',
          images[host],
          tree,
        ],
        { cwd: tree, stream: true },
      );
      retainedImages.push(images[host]);
    }
    let repoDigest;
    if (!rebuildWeb) {
      emit(`build-channel: pulling stock web ${images.web} for ${platform}`);
      await command('docker', ['pull', '--platform', platform, images.web]);
      retainedImages.push(images.web);
      const digests = JSON.parse(
        (
          await command(
            'docker',
            ['image', 'inspect', '--format', '{{json .RepoDigests}}', images.web],
            { quiet: true },
          )
        ).stdout,
      );
      repoDigest = digests.find((digest) =>
        digest.startsWith(`${images.web.slice(0, images.web.lastIndexOf(':'))}@sha256:`),
      );
      if (!repoDigest || !/@sha256:[a-f0-9]{64}$/.test(repoDigest))
        throw new Error('could not read the pulled stock web RepoDigest');
    }
    const readIds = async () => {
      const result = {};
      for (const [host, ref] of Object.entries(images)) {
        const image = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
          quiet: true,
        });
        const id = image.stdout.trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(id))
          throw new Error(`could not read the local image id for ${host}`);
        result[host] = id;
      }
      return result;
    };
    const beforeGate = await readIds();
    const gate = await command(
      process.execPath,
      [
        join(root, 'scripts', 'channel-gate.mjs'),
        '--expect',
        expectFile,
        '--token-file',
        tokenFile,
      ],
      { allowFailure: true },
    );
    if (gate.error || ![0, 1, 2].includes(gate.status))
      throw new Error('channel gate could not finish');
    const afterGate = await readIds();
    for (const host of Object.keys(images)) {
      if (beforeGate[host] !== afterGate[host])
        throw new Error(`local image id changed during gate: ${images[host]}`);
    }
    if (gate.status !== 0) {
      emit(`build-channel: gate failed; tags retained for diagnosis: ${retainedImages.join(', ')}`);
      return gate.status;
    }
    const recordedImages = Object.fromEntries(
      Object.entries(images).map(([host, ref]) => [
        host,
        {
          ref,
          built: hosts.includes(host),
          id: beforeGate[host],
          ...(!rebuildWeb && host === 'web' ? { repoDigest } : {}),
        },
      ]),
    );
    const pending = join(out, `.build-record-${process.pid}.json`);
    try {
      put(pending, {
        schema: 2,
        tag,
        commit,
        channel,
        version,
        platform,
        imageStore,
        images: recordedImages,
        modules,
      });
      renameSync(pending, join(out, 'build-record.json'));
    } finally {
      try {
        rmSync(pending, { force: true });
      } catch {
        emit(`build-channel: cleanup failed; leftover path ${pending}`);
      }
    }
    emit(`build-channel: passed; record ${join(out, 'build-record.json')}`);
    return 0;
  } catch (error) {
    emit(`build-channel: ${error.message}`);
    if (retainedImages.length)
      emit(`build-channel: tags retained for diagnosis: ${retainedImages.join(', ')}`);
    return 2;
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        emit(`build-channel: cleanup failed; leftover path ${scratch}`);
      }
    }
  }
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
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => controller.abort());
  run(process.argv.slice(2), { signal: controller.signal }).then((code) => {
    process.exitCode = code;
  });
}
