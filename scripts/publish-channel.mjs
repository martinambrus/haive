#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseReleaseManifest } from '../packages/shared/src/release/manifest.ts';
import { parseRecord, run as checkBoot } from './channel-boot-check.mjs';

import { createCapture, LOCAL_IMAGE_NOT_FOUND } from './channel-capture.mjs';

const capture = createCapture(4);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEYS = ['api', 'worker', 'web', 'builder'];
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const PREFIX = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
// Volatile Docker daemon wording; used only with exit 1 and no spawn error.
// A normalized or reworded ref is not proof of absence and refuses with exit 2.
const DAEMON_NOT_FOUND = (ref) =>
  new RegExp(`^ERROR: ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not found$`, 'm');
const DAEMON_DENIED = /failed to authorize|unauthorized|\bdenied\b|\b40[13]\b|forbidden/i;
const DAEMON_TRANSPORT_ERROR =
  /\b(?:5\d\d|networks?|connections?|timeouts?|timed out|no such host|credential helpers?|tls|certificates?|eof)\b/i;
const USAGE =
  'usage: node scripts/publish-channel.mjs --record <build-record.json> [--registry <prefix; defaults to record api prefix>] [--out <dir; defaults beside record>] [--dry-run] [--confirm-absent <exact destination ref; repeatable>] [--timeout-ms <boot-stage timeout>] — writes release.json locally and publishes its manifest image last';

export async function run(
  argv,
  {
    root = ROOT,
    runner = capture,
    request = fetch,
    bootCheck = checkBoot,
    env = process.env,
    say = (line) => process.stdout.write(`${line}\n`),
    signal,
  } = {},
) {
  let scratch;
  let output;
  let manifestWritten = false;
  let recovery;
  const attempted = [];
  const verified = [];
  const emit = (line) => say(String(line).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'));
  const interrupted = () => signal?.throwIfAborted();
  const command = async (cmd, args, allowFailure = false) => {
    interrupted();
    const result = await runner(cmd, args, { cwd: root, env, timeout: 1_800_000, signal });
    interrupted();
    if (!allowFailure && (result.status !== 0 || result.error))
      throw new Error(`${cmd} ${args[0]} failed (exit ${result.status ?? 'none'})`);
    return result;
  };
  const docker = (args, allowFailure) => command('docker', args, allowFailure);
  const inspect = (ref) =>
    docker(['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', ref], true);
  const localTag = async (ref, inspectLocal = docker) => {
    const result = await inspectLocal(['image', 'inspect', '--format', '{{.Id}}', ref], true);
    if (result.status === 0 && !result.error && DIGEST.test(result.stdout.trim()))
      return result.stdout.trim();
    if (result.status === 1 && !result.error && LOCAL_IMAGE_NOT_FOUND.test(result.stderr ?? ''))
      return undefined;
    throw new Error(`could not inspect local tag ${ref}`);
  };
  const withLocalTag = async (ref, publish) => {
    const previous = await localTag(ref);
    try {
      await publish();
    } catch (error) {
      // Keep the recorded source image and any tag that existed before this run.
      try {
        const result = await runner(
          'docker',
          previous ? ['image', 'tag', previous, ref] : ['image', 'rm', ref],
          { cwd: root, env, timeout: 15_000 },
        );
        if (result.status !== 0 || result.error) throw new Error('local tag cleanup failed');
      } catch {
        let absent = false;
        try {
          absent =
            (await localTag(ref, (args) =>
              runner('docker', args, { cwd: root, env, timeout: 15_000 }),
            )) === undefined;
        } catch {
          // An inconclusive inspect cannot prove cleanup succeeded.
        }
        if (!absent) emit(`publish-channel: cleanup failed; local tag retained at ${ref}`);
      }
      throw error;
    }
  };

  let confirmations = new Set();
  const absent = async (ref) => {
    const result = await inspect(ref);
    if (result.status === 0 && !result.error) {
      const descriptor = JSON.parse(result.stdout);
      if (!DIGEST.test(descriptor?.digest))
        throw new Error(`malformed registry inspect for ${ref}`);
      emit(`publish-channel: existing tag ${ref}`);
      return false;
    }
    const unproven = () => new Error(`absence of ${ref} could not be proven`);
    const stderr = result.stderr ?? '';
    const diagnostics = stderr.replaceAll(ref, '');
    const daemonUsable =
      result.status === 1 && !result.error && !DAEMON_TRANSPORT_ERROR.test(diagnostics);
    const daemonAbsent =
      daemonUsable && DAEMON_NOT_FOUND(ref).test(stderr) && !DAEMON_DENIED.test(diagnostics);
    const daemonDenied = daemonUsable && DAEMON_DENIED.test(diagnostics);
    if (!daemonAbsent && !daemonDenied) throw unproven();
    const slash = ref.indexOf('/');
    const host = ref.slice(0, slash);
    const colon = ref.lastIndexOf(':');
    const repository = ref.slice(slash + 1, colon);
    const tag = ref.slice(colon + 1);
    const scheme = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ? 'http' : 'https';
    const bounded = AbortSignal.timeout(30_000);
    const headers = { Accept: 'application/vnd.oci.image.manifest.v1+json' };
    const get = async (url, requestHeaders = headers) => {
      try {
        const response = await request(url, {
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, bounded]) : bounded,
          headers: requestHeaders,
        });
        interrupted();
        return response;
      } catch {
        interrupted();
        throw unproven();
      }
    };
    const json = async (response) => {
      try {
        return await response.json();
      } catch {
        interrupted();
        throw unproven();
      }
    };
    const manifestUrl = `${scheme}://${host}/v2/${repository}/manifests/${tag}`;
    let response = await get(manifestUrl);
    let denied = false;
    if (response.status === 401) {
      const challenge = response.headers?.get('www-authenticate');
      if (!/^Bearer\s+/i.test(challenge ?? '')) throw unproven();
      const params = new Map();
      const fields = challenge.replace(/^Bearer\s+/i, '');
      let end = 0;
      for (const match of fields.matchAll(/([a-z]+)="([^"\\]*)"(?:,\s*|$)/gi)) {
        if (match.index !== end || params.has(match[1].toLowerCase())) throw unproven();
        params.set(match[1].toLowerCase(), match[2]);
        end = match.index + match[0].length;
      }
      if (end !== fields.length || !params.get('service') || !params.get('scope')) throw unproven();
      let realm;
      try {
        realm = new URL(params.get('realm'));
      } catch {
        interrupted();
        throw unproven();
      }
      if (
        realm.protocol !== 'https:' ||
        realm.host !== host ||
        realm.username ||
        realm.password ||
        realm.hash
      )
        throw unproven();
      realm.searchParams.set('service', params.get('service'));
      realm.searchParams.set('scope', params.get('scope'));
      const tokenResponse = await get(realm.href);
      if ([401, 403].includes(tokenResponse.status)) denied = true;
      else {
        if (tokenResponse.status !== 200) throw unproven();
        const body = await json(tokenResponse);
        if (
          Array.isArray(body?.errors) &&
          body.errors.length &&
          body.errors.every((error) => error.code === 'DENIED')
        )
          denied = true;
        else {
          const token = body?.token ?? body?.access_token;
          if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw unproven();
          response = await get(manifestUrl, { ...headers, Authorization: `Bearer ${token}` });
          denied = response.status === 401 || response.status === 403;
        }
      }
    } else if (response.status === 403) denied = true;
    if (denied) {
      if (daemonAbsent)
        emit(`publish-channel: absence ${ref}: daemon-only (anonymous access denied)`);
      else if (confirmations.has(ref))
        emit(
          `publish-channel: plan WARNING: --confirm-absent ${ref} overrides inconclusive access-denied proof`,
        );
      else throw unproven();
    } else {
      const body = await json(response);
      if (
        !daemonAbsent ||
        response.status !== 404 ||
        !Array.isArray(body?.errors) ||
        !body.errors.length ||
        body.errors.some((error) => !['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(error.code))
      )
        throw unproven();
      emit(`publish-channel: absence ${ref}: corroborated`);
    }
    return true;
  };
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        record: { type: 'string', multiple: true },
        registry: { type: 'string', multiple: true },
        out: { type: 'string', multiple: true },
        'timeout-ms': { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        'confirm-absent': { type: 'string', multiple: true },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    });
    if (values.help) {
      emit(USAGE);
      return 0;
    }
    if (values.record?.length !== 1) throw new Error(`exactly one --record is required; ${USAGE}`);
    for (const key of ['registry', 'out', 'timeout-ms'])
      if (values[key]?.length > 1) throw new Error(`only one --${key} is allowed`);
    if (values['timeout-ms']) {
      const timeout = values['timeout-ms'][0];
      if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 600_000)
        throw new Error('invalid --timeout-ms');
    }
    const recordPath = resolve(values.record[0]);
    const record = parseRecord(readFileSync(recordPath, 'utf8'));
    const suffix = `/haive-${record.channel}-api:${record.version}`;
    if (!record.images.api.ref.endsWith(suffix))
      throw new Error('record api ref has no channel prefix');
    const originalPrefix = record.images.api.ref.slice(0, -suffix.length);
    const registry = values.registry?.[0] ?? originalPrefix;
    if (!PREFIX.test(registry) || !PREFIX.test(originalPrefix))
      throw new Error(
        'registry must be a lowercase repository prefix without a scheme or credentials',
      );
    const destinations = Object.fromEntries(
      [...KEYS, 'release'].map((host) => [
        host,
        `${registry}/haive-${record.channel}-${host}:${record.version}`,
      ]),
    );
    recovery = { ref: destinations.release, platform: record.platform };
    confirmations = new Set(values['confirm-absent'] ?? []);
    for (const ref of confirmations)
      if (!Object.values(destinations).includes(ref))
        throw new Error('--confirm-absent is not a destination');
    if (!record.images.builder)
      throw new Error(
        `record has no builder (schema ${record.schema}); rebuild the channel with build-channel`,
      );
    for (const host of ['api', 'worker', 'builder'])
      if (!record.images[host].built) throw new Error(`record ${host} must be built`);
    if (!record.images.web.built) {
      const pinned = record.images.web.repoDigest;
      const at = typeof pinned === 'string' ? pinned.lastIndexOf('@') : -1;
      if (at < 1 || !PREFIX.test(pinned.slice(0, at)) || !DIGEST.test(pinned.slice(at + 1)))
        throw new Error('stock web needs a recorded repoDigest without credentials');
    }
    const readIds = async () => {
      for (const host of KEYS) {
        const image = record.images[host];
        const result = await docker(['image', 'inspect', '--format', '{{.Id}}', image.ref]);
        if (result.stdout.trim() !== image.id)
          throw new Error(`${host} ${image.ref} no longer resolves to recorded id ${image.id}`);
      }
    };
    await readIds();
    const tempBase = realpathSync(tmpdir());
    const rel = relative(realpathSync(root), tempBase);
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
      throw new Error('TMPDIR must be outside the repository');
    scratch = mkdtempSync(join(tempBase, 'publish-channel-'));
    const snapshot = join(scratch, 'build-record.json');
    writeFileSync(snapshot, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    const bootArgs = ['--record', snapshot];
    if (values['timeout-ms']) bootArgs.push('--timeout-ms', values['timeout-ms'][0]);
    const bootStatus = await bootCheck(bootArgs, { root, runner, request, say: emit, env, signal });
    interrupted();
    if (bootStatus !== 0) {
      if (![1, 2].includes(bootStatus)) throw new Error('boot check did not finish');
      emit(`publish-channel: boot gate refused (exit ${bootStatus}); no manifest written`);
      return bootStatus;
    }
    let existing = false;
    for (const ref of Object.values(destinations)) if (!(await absent(ref))) existing = true;
    if (existing) return 1;
    await readIds();
    const expected = {};
    const sources = {};
    const platformDigest = async (host, image) => {
      const archive = join(scratch, `${host}.tar`);
      await docker(['image', 'save', '--platform', record.platform, '--output', archive, image.id]);
      const index = JSON.parse((await command('tar', ['-xOf', archive, 'index.json'])).stdout);
      const candidates = index.manifests?.filter(
        (entry) =>
          !entry.artifactType &&
          entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest' &&
          `${entry.platform?.os}/${entry.platform?.architecture}` === record.platform,
      );
      const descriptor = candidates?.[0];
      if (candidates?.length !== 1 || !DIGEST.test(descriptor?.digest))
        throw new Error(`cannot identify one gated platform manifest for ${host}`);
      const raw = (
        await command('tar', ['-xOf', archive, `blobs/sha256/${descriptor.digest.slice(7)}`])
      ).stdout;
      const manifest = JSON.parse(raw);
      if (
        `sha256:${createHash('sha256').update(raw).digest('hex')}` !== descriptor.digest ||
        manifest.artifactType ||
        manifest.subject ||
        !manifest.config ||
        !Array.isArray(manifest.layers) ||
        ![
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].includes(manifest.mediaType)
      )
        throw new Error(`invalid gated platform manifest for ${host}`);
      rmSync(archive, { force: true });
      return descriptor.digest;
    };
    for (const host of KEYS) {
      const image = record.images[host];
      expected[host] = await platformDigest(host, image);
      if (!image.built) {
        const repoDigest = image.repoDigest;
        const remote = JSON.parse(
          (await docker(['buildx', 'imagetools', 'inspect', '--raw', repoDigest])).stdout,
        );
        const digest = repoDigest.slice(repoDigest.lastIndexOf('@') + 1);
        if (
          digest !== expected[host] &&
          !remote.manifests?.some(
            (entry) =>
              entry.digest === expected[host] &&
              `${entry.platform?.os}/${entry.platform?.architecture}` === record.platform,
          )
        )
          throw new Error(`stock ${host} repoDigest does not contain the gated platform manifest`);
        sources[host] = `${repoDigest.slice(0, repoDigest.lastIndexOf('@'))}@${expected[host]}`;
      }
      emit(
        `publish-channel: plan ${host}: ${sources[host] ?? image.id} -> ${destinations[host]} @ ${expected[host]} (platform only)`,
      );
    }
    const tree = join(scratch, 'tree');
    mkdirSync(tree);
    const archive = join(scratch, 'release-tree.tar');
    await command('git', [
      'archive',
      '--format=tar',
      `--output=${archive}`,
      record.commit,
      '--',
      'scripts/build-release-manifest.mjs',
      'packages/database/migrations',
    ]);
    await command('tar', ['-xf', archive, '-C', tree]);
    const images = Object.fromEntries(
      KEYS.map((host) => [
        host,
        `${destinations[host].slice(0, destinations[host].lastIndexOf(':'))}@${expected[host]}`,
      ]),
    );
    const result = await command(process.execPath, [
      join(tree, 'scripts/build-release-manifest.mjs'),
      '--version',
      record.tag,
      '--channel',
      record.channel,
      ...['api', 'worker', 'web'].flatMap((host) => [`--${host}`, images[host]]),
    ]);
    const generated = JSON.parse(result.stdout);
    const manifest = parseReleaseManifest({
      ...generated,
      images: { ...generated.images, builder: images.builder },
    });
    if (
      manifest.version !== record.version ||
      manifest.channel !== record.channel ||
      KEYS.some((host) => manifest.images[host] !== images[host])
    )
      throw new Error('record tree produced an inconsistent release manifest');
    output = join(resolve(values.out?.[0] ?? dirname(recordPath)), 'release.json');
    emit(
      `publish-channel: plan manifest ${output} then ${destinations.release} LAST (metadata from ${record.commit})`,
    );
    if (existsSync(output)) throw new Error(`manifest already exists: ${output}`);
    if (values['dry-run']) {
      emit('publish-channel: dry-run passed; nothing pushed; no manifest written');
      return 0;
    }
    mkdirSync(dirname(output), { recursive: true });
    for (const host of KEYS) {
      if (!(await absent(destinations[host]))) {
        emit(
          `publish-channel: tag appeared before push; no manifest written; attempted: ${attempted.join(', ') || 'none'}`,
        );
        return attempted.length ? 2 : 1;
      }
      if (sources[host]) {
        attempted.push(destinations[host]);
        await docker([
          'buildx',
          'imagetools',
          'create',
          '--prefer-index=false',
          '--tag',
          destinations[host],
          sources[host],
        ]);
      } else {
        await withLocalTag(destinations[host], async () => {
          await docker(['image', 'tag', record.images[host].id, destinations[host]]);
          attempted.push(destinations[host]);
          await docker(['push', '--platform', record.platform, destinations[host]]);
        });
      }
      const pushed = await inspect(destinations[host]);
      if (
        pushed.status !== 0 ||
        pushed.error ||
        JSON.parse(pushed.stdout).digest !== expected[host]
      )
        throw new Error(`pushed digest verification failed for ${destinations[host]}`);
      verified.push(destinations[host]);
      emit(`publish-channel: published ${destinations[host]} @ ${expected[host]}`);
    }
    interrupted();
    const pending = join(
      dirname(output),
      `.release-${process.pid}-${scratch.split(sep).at(-1)}.json`,
    );
    try {
      writeFileSync(pending, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      linkSync(pending, output);
      manifestWritten = true;
    } finally {
      rmSync(pending, { force: true });
    }
    const context = mkdtempSync(join(scratch, 'manifest-image-'));
    writeFileSync(join(context, 'release.json'), readFileSync(output), { mode: 0o600, flag: 'wx' });
    writeFileSync(
      join(context, 'Dockerfile'),
      'FROM scratch\nCOPY release.json /release.json\nLABEL org.haive.release=1\n',
      { mode: 0o600, flag: 'wx' },
    );
    await withLocalTag(destinations.release, async () => {
      await docker([
        'buildx',
        'build',
        '--platform',
        record.platform,
        '--load',
        '--tag',
        destinations.release,
        context,
      ]);
      expected.release = await platformDigest('release', { id: destinations.release });
      if (!(await absent(destinations.release)))
        throw new Error('release tag appeared before its push');
      attempted.push(destinations.release);
      await docker(['push', '--platform', record.platform, destinations.release]);
    });
    const pushed = await inspect(destinations.release);
    if (
      pushed.status !== 0 ||
      pushed.error ||
      JSON.parse(pushed.stdout).digest !== expected.release
    )
      throw new Error(`pushed digest verification failed for ${destinations.release}`);
    verified.push(destinations.release);
    emit(`publish-channel: published ${destinations.release} @ ${expected.release}`);
    emit(`publish-channel: passed; manifest ${output}`);
    return 0;
  } catch (error) {
    if (manifestWritten) {
      emit(
        `publish-channel: recovery: inspect ${recovery.ref} before retrying; if it is already published, verify its /release.json against the retained file`,
      );
      emit(
        `publish-channel: recovery inspect: docker buildx imagetools inspect ${shellQuote(recovery.ref)}`,
      );
      emit(
        `publish-channel: recovery command: ( recovery_dir=$(mktemp -d) && trap 'rm -rf -- "$recovery_dir"' EXIT && cp -- ${shellQuote(output)} "$recovery_dir/release.json" && printf '%s\\n' 'FROM scratch' 'COPY release.json /release.json' 'LABEL org.haive.release=1' > "$recovery_dir/Dockerfile" && docker buildx build --platform ${shellQuote(recovery.platform)} --load --tag ${shellQuote(recovery.ref)} "$recovery_dir" && docker push --platform ${shellQuote(recovery.platform)} ${shellQuote(recovery.ref)} )`,
      );
    }
    emit(
      `publish-channel: could not publish: ${error.message}; ${manifestWritten ? `local manifest retained at ${output}` : 'no manifest written'}; attempted: ${attempted.join(', ') || 'none'}; verified: ${verified.join(', ') || 'none'}`,
    );
    return 2;
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        emit(`publish-channel: cleanup failed; leftover path ${scratch}`);
        return 2;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  // A terminal may close stdout before sending SIGHUP; keep abort cleanup alive.
  process.stdout.on('error', (error) => {
    if (!controller.signal.aborted) throw error;
  });
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  process.exitCode = await run(process.argv.slice(2), { signal: controller.signal });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGHUP', stop);
}
