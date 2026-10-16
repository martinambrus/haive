import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Copy of the pattern behind modulePackageId in @haive/shared/modularity; packages/shared/test/modularity.test.ts pins the two equal.
const MODULE_PACKAGE = /^(?:@haive\/module-|@haive-module\/)([a-z0-9][a-z0-9-]{0,22})$/;
export const idOf = (name) => MODULE_PACKAGE.exec(name)?.[1] ?? null;

const USAGE = 'usage: node scripts/channel-gate.mjs --expect <expect.json> --token-file <file>';
const KEYS = ['api', 'worker', 'web'];
const WEB_PARTS = ['dashboard', 'web'];
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const REGISTRY_PREFIX = '@haive-module+';
const WEB_LIST = '/app/packages/web/modules.generated.json';
const SCAN_IMAGE = fileURLToPath(new URL('./smoke/scan-image.sh', import.meta.url));
const INSPECT_MS = 60_000;
const READ_MS = 180_000;
const SAVE_MS = 900_000;

export class CouldNotLook extends Error {}

const offender = (key, check, what) => ({ key, check, what });
const byWhat = (a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0);
const finish = (offenders) => [...new Map(offenders.map((o) => [o.what, o])).values()].sort(byWhat);
const tail = (text) => (text.trim().split('\n').at(-1) ?? '').trim().slice(0, 300);
const failure = (r) => (r.timedOut ? 'timed out' : (r.error?.message ?? tail(r.stderr)));

const printable = (text) =>
  text.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
export const formatOffender = ({ key, check, what }) =>
  `OFFENDER ${key} ${check} ${printable(what)}`;

export function foldExit(offenders, couldNot) {
  if (couldNot.length > 0) return 2;
  return offenders.length > 0 ? 1 : 0;
}

export function parseExpect(text) {
  const bad = (why) => {
    throw new CouldNotLook(`malformed expectation: ${why}`);
  };
  const object = (value, what, keys) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      bad(`${what} is not an object`);
    }
    const unknown = Object.keys(value).filter((key) => !keys.includes(key));
    if (unknown.length > 0) bad(`${what} has the unknown key ${JSON.stringify(unknown[0])}`);
    return value;
  };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    bad('not valid JSON');
  }
  object(doc, 'the file', ['version', 'images', 'modules']);
  if (typeof doc.version !== 'string' || doc.version === '') {
    bad('version is not a non-empty string');
  }
  const images = object(doc.images, 'images', KEYS);
  for (const key of ['api', 'worker']) {
    if (images[key] === undefined) bad(`images.${key} is missing`);
  }
  for (const [key, ref] of Object.entries(images)) {
    if (typeof ref !== 'string' || !IMAGE_REF.test(ref)) {
      bad(`images.${key} is not an image reference`);
    }
  }
  if (!Array.isArray(doc.modules)) bad('modules is not a list');
  const ids = new Set();
  const modules = doc.modules.map((entry, i) => {
    const at = `modules[${i}]`;
    object(entry, at, ['packageName', 'source', 'version', 'webParts']);
    const id = typeof entry.packageName === 'string' ? idOf(entry.packageName) : null;
    if (id === null) bad(`${at}.packageName is not a module package name`);
    if (entry.source !== 'local' && entry.source !== 'registry') {
      bad(`${at}.source is neither "local" nor "registry"`);
    }
    if (entry.source === 'registry' && !entry.packageName.startsWith('@haive-module/')) {
      bad(`${at} is a registry module, so its package name is @haive-module/<id>`);
    }
    if (
      entry.version !== undefined &&
      (entry.source !== 'registry' || typeof entry.version !== 'string' || entry.version === '')
    ) {
      bad(`${at}.version is for a registry module and must be a non-empty string`);
    }
    if (entry.source === 'registry' && entry.version === undefined) {
      bad(`${at} is the registry module ${entry.packageName}, which has no version`);
    }
    const parts = entry.webParts ?? [];
    if (
      !Array.isArray(parts) ||
      parts.some((part) => !WEB_PARTS.includes(part)) ||
      new Set(parts).size !== parts.length
    ) {
      bad(`${at}.webParts is not a list of distinct "dashboard" or "web"`);
    }
    if (ids.has(id)) bad(`two modules have the id ${id}`);
    ids.add(id);
    return {
      packageName: entry.packageName,
      id,
      source: entry.source,
      version: entry.version,
      webParts: [...parts].sort(),
    };
  });
  return { version: doc.version, images: { ...images }, modules };
}

export function parseToken(text) {
  const token = text.trim();
  if (token === '') throw new CouldNotLook('the token file is empty');
  if (/[\s\p{Cc}]/u.test(token)) {
    throw new CouldNotLook('the token file does not hold one bare token on one line');
  }
  return token;
}

// The version ends at the first underscore: semver has none, and pnpm starts the peer suffix with one.
export function parseRegistryComponent(component) {
  const rest = component.slice(REGISTRY_PREFIX.length);
  const at = rest.indexOf('@');
  if (at === -1) return null;
  const id = idOf(`@haive-module/${rest.slice(0, at)}`);
  const version = rest.slice(at + 1).split('_')[0];
  return id === null || version === '' ? null : { id, version };
}

export function newFootprint() {
  return {
    registry: new Map(),
    badComponents: new Set(),
    links: new Set(),
    folders: new Map(),
    notDirs: new Set(),
    npmrc: [],
  };
}

export function scanLayerNames(footprint, layer, names) {
  for (const member of names) {
    const isDir = member.endsWith('/');
    const parts = member
      .replace(/^(?:\.\/)+/, '')
      .replace(/\/+$/, '')
      .split('/');
    const last = parts.length - 1;
    if (parts[last].startsWith('.wh.')) continue;
    parts.forEach((part, i) => {
      if (part.startsWith(REGISTRY_PREFIX)) {
        const parsed = parseRegistryComponent(part);
        if (parsed === null) {
          footprint.badComponents.add(part);
        } else {
          const versions = footprint.registry.get(parsed.id) ?? new Set();
          footprint.registry.set(parsed.id, versions.add(parsed.version));
        }
      } else if (part === '@haive-module' && parts[i - 1] === 'node_modules' && i < last) {
        footprint.links.add(parts[i + 1]);
      }
    });
    if (
      parts[0] === 'app' &&
      parts[1] === 'modules' &&
      (parts.length > 3 || (isDir && parts.length === 3))
    ) {
      if (!footprint.folders.has(parts[2])) footprint.folders.set(parts[2], null);
      if (!isDir && parts.length === 4 && parts[3] === 'package.json') {
        footprint.folders.set(parts[2], { layer, member });
      }
    }
    if (
      parts[0] === 'app' &&
      parts[1] === 'modules' &&
      parts.length === 3 &&
      !isDir &&
      parts[2] !== '.gitkeep'
    ) {
      footprint.notDirs.add(parts[2]);
    }
    if (!isDir && parts[last] === '.npmrc') {
      footprint.npmrc.push({ layer, member, name: parts.join('/') });
    }
  }
}

export function packageNameOf(text) {
  try {
    const name = JSON.parse(text)?.name;
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

export function comparePresence(key, footprint, folderNames, expect) {
  const out = [];
  const offend = (what) => out.push(offender(key, 'presence', what));
  const web = key === 'web';
  const wanted = expect.modules.filter((m) => !web || m.webParts.length > 0);

  const folders = new Map();
  for (const [dir, name] of folderNames) {
    const id = name === null ? null : idOf(name);
    if (name === null) {
      offend(`app/modules/${dir} has no package.json`);
    } else if (id === null) {
      offend(
        `app/modules/${dir} has a package.json named ${JSON.stringify(name)}, not a module package`,
      );
    } else {
      folders.set(id, dir);
    }
  }
  const registry = new Map(footprint.registry);
  for (const link of footprint.links) {
    const id = idOf(`@haive-module/${link}`);
    if (id === null) {
      offend(`node_modules/@haive-module/${link} is not a module package name`);
    } else if (!registry.has(id) && !folders.has(id)) {
      registry.set(id, new Set());
    }
  }
  for (const component of footprint.badComponents) {
    offend(`${component} is not a module package name and version`);
  }
  for (const name of footprint.notDirs) offend(`app/modules/${name} is not a directory`);

  const compare = (found, source, describe) => {
    const want = new Set(wanted.filter((m) => m.source === source).map((m) => m.id));
    for (const id of found.keys()) {
      if (!want.has(id)) offend(`${describe(id)} is in the image but not expected`);
    }
    if (web) return;
    for (const id of want) {
      if (!found.has(id)) offend(`${describe(id)} is expected but not in the image`);
    }
  };
  compare(registry, 'registry', (id) => `registry module ${id}`);
  compare(
    folders,
    'local',
    (id) => `module folder ${id}${folders.has(id) ? ` (app/modules/${folders.get(id)})` : ''}`,
  );
  for (const m of wanted) {
    if (m.version === undefined) continue;
    const versions = registry.get(m.id);
    if (!web && m.source === 'registry' && versions?.size === 0) {
      offend(`${m.id} is in the image with no version to read, expected ${m.id}@${m.version}`);
    }
    for (const found of [...(versions ?? [])].sort()) {
      if (found !== m.version) {
        offend(`${m.id}@${found} is in the image, expected ${m.id}@${m.version}`);
      }
    }
  }
  return finish(out);
}

export function readerScript(key) {
  if (key === 'web') {
    return `import { existsSync, readFileSync } from 'node:fs';
const file = '${WEB_LIST}';
const result = existsSync(file) ? { list: JSON.parse(readFileSync(file, 'utf8')) } : { missing: true };
process.stdout.write(JSON.stringify(result) + '\\n', () => process.exit(0));
`;
  }
  return `import { existsSync } from 'node:fs';
const file = '/app/packages/${key}/dist/modules.generated.js';
if (!existsSync(file)) {
  process.stdout.write(JSON.stringify({ missing: true }) + '\\n', () => process.exit(0));
} else {
  const { moduleRegistry } = await import('file://' + file);
  const { moduleManifestSchema, modulePackageId } = await import('@haive/shared/modularity');
  const entries = moduleRegistry.map((entry) => {
    const parsed = moduleManifestSchema.safeParse(entry.manifest);
    let problem = null;
    if (!parsed.success) problem = 'an invalid manifest';
    else if (modulePackageId(entry.packageName) !== parsed.data.id) problem = 'a manifest that declares the id ' + JSON.stringify(parsed.data.id);
    return { packageName: String(entry.packageName), source: String(entry.source), problem };
  });
  process.stdout.write(JSON.stringify({ entries }) + '\\n', () => process.exit(0));
}
`;
}

// The reader's result is the last stdout line: a module may log while it is imported.
export function parseReading(key, text) {
  const bad = () => new CouldNotLook('the in-image reader printed no result that can be read');
  let doc;
  try {
    doc = JSON.parse(
      text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .at(-1) ?? '',
    );
  } catch {
    throw bad();
  }
  const entry = (e) =>
    e !== null &&
    typeof e === 'object' &&
    typeof e.packageName === 'string' &&
    typeof e.source === 'string' &&
    (e.problem === null || typeof e.problem === 'string');
  const found =
    key === 'web'
      ? doc?.list !== undefined
      : Array.isArray(doc?.entries) && doc.entries.every(entry);
  if (doc === null || typeof doc !== 'object' || (doc.missing !== true && !found)) throw bad();
  return doc;
}

const webEntry = (e) =>
  e !== null &&
  typeof e === 'object' &&
  typeof e.packageName === 'string' &&
  typeof e.source === 'string' &&
  Array.isArray(e.parts) &&
  e.parts.every((part) => typeof part === 'string');
const listKey = (packageName, source) => `${packageName} (${source})`;
const webKey = (packageName, source, parts) =>
  `${listKey(packageName, source)} ${[...parts].sort().join('+')}`;
const listedVersion = (version) =>
  version === undefined ? 'no version' : `version ${JSON.stringify(version)}`;

export function compareLists(key, reading, expect) {
  const out = [];
  const offend = (what) => out.push(offender(key, 'lists', what));
  const web = key === 'web';
  const have = new Set();
  const want = new Set();
  if (reading.missing === true) {
    offend(`${web ? WEB_LIST : `/app/packages/${key}/dist/modules.generated.js`} does not exist`);
    return out;
  }
  if (web) {
    if (!Array.isArray(reading.list)) {
      offend(`${WEB_LIST} is not a list`);
      return out;
    }
    for (const e of reading.list) {
      if (webEntry(e)) have.add(webKey(e.packageName, e.source, e.parts));
      else offend(`${WEB_LIST} holds an entry that is not {packageName, source, parts}`);
    }
    for (const m of expect.modules.filter((m) => m.webParts.length > 0)) {
      const key = webKey(m.packageName, m.source, m.webParts);
      want.add(key);
      if (m.source !== 'registry') continue;
      const listed = reading.list.filter(
        (e) => webEntry(e) && webKey(e.packageName, e.source, e.parts) === key,
      );
      for (const { version } of listed) {
        if (version !== m.version) {
          offend(`${key} is listed with ${listedVersion(version)}, expected ${m.version}`);
        }
      }
    }
  } else {
    for (const e of reading.entries) {
      have.add(listKey(e.packageName, e.source));
      if (e.problem !== null) {
        offend(`${listKey(e.packageName, e.source)} is listed with ${e.problem}`);
      }
    }
    for (const m of expect.modules) want.add(listKey(m.packageName, m.source));
  }
  for (const item of have) {
    if (!want.has(item)) offend(`${item} is listed but not expected`);
  }
  for (const item of want) {
    if (!have.has(item)) offend(`${item} is expected but not listed`);
  }
  return finish(out);
}

export function compareStamp(key, env, version) {
  const prefix = 'HAIVE_VERSION=';
  const values = env
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
  if (values.length === 0) {
    return [offender(key, 'stamp', `HAIVE_VERSION is unset, the channel version is ${version}`)];
  }
  return finish(
    values
      .filter((value) => value !== version)
      .map((value) =>
        offender(
          key,
          'stamp',
          `HAIVE_VERSION=${JSON.stringify(value)}, the channel version is ${version}`,
        ),
      ),
  );
}

// The D1b rule of scripts/module-dist-smoke.sh (npmrc_credentials): line numbers only, never a value.
export function authLineNumbers(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (/^[ \t]*[#;]/.test(line)) return;
    if (
      /^[ \t]*([^ \t=#;]*:)?_(auth|authToken|password)[ \t]*=/.test(line) ||
      /:\/\/[^/@ \t]*:[^/@ \t]*@/.test(line)
    ) {
      found.push(i + 1);
    }
  });
  return found;
}

export function compareToken(key, { status, stdout, stderr }) {
  const match = /history=(\d+) inspect=(\d+) config=(\d+) layers=(\d+) tars=\d+/.exec(
    String(stdout),
  );
  if (match === null || (status !== 0 && status !== 1)) {
    throw new CouldNotLook(
      `scan-image.sh could not read the image (exit ${status}): ${tail(String(stderr))}`,
    );
  }
  if (status === 0 && match.slice(1, 5).every((count) => count === '0')) return [];
  return [offender(key, 'token', `the vendor token is in the image: ${match[0]}`)];
}

const cleanups = new Set();
function cleanUp() {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {}
  }
  cleanups.clear();
}

function capture(cmd, args, { input, env, timeout = SAVE_MS } = {}) {
  return new Promise((done) => {
    // A process group of its own, so that an abort stops the whole pipeline of a bash -c.
    const child = spawn(cmd, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => process.kill(-child.pid, 'SIGTERM');
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        stop();
      } catch {}
    }, timeout);
    cleanups.add(stop);
    const settle = (status, error) => {
      clearTimeout(timer);
      cleanups.delete(stop);
      done({
        status,
        error,
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString(),
      });
    };
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => settle(null, error));
    child.on('close', (status) => settle(status));
    child.stdin.end(input);
  });
}

async function readMember(blob, member) {
  const r = await capture('tar', ['--no-wildcards', '-xOf', blob, '--', member]);
  if (r.status !== 0) throw new CouldNotLook(`cannot read ${member} from a layer: ${failure(r)}`);
  return r.stdout.toString('utf8');
}

function layerBlobs(dir) {
  const bad = () =>
    new CouldNotLook('docker save did not hold one image with layers in manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw bad();
  }
  const layers = Array.isArray(manifest) && manifest.length === 1 ? manifest[0]?.Layers : null;
  if (!Array.isArray(layers) || layers.length === 0 || layers.some((l) => typeof l !== 'string')) {
    throw bad();
  }
  return layers.map((layer) => join(dir, layer));
}

async function checkLayers(key, ref, expect) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-gate.'));
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  cleanups.add(remove);
  try {
    const saved = await capture('bash', [
      '-o',
      'pipefail',
      '-c',
      'docker save "$1" | tar -x -C "$2"',
      '_',
      ref,
      dir,
    ]);
    if (saved.status !== 0) {
      throw new CouldNotLook(`docker save of ${ref} failed: ${failure(saved)}`);
    }
    const blobs = layerBlobs(dir);
    const footprint = newFootprint();
    for (const [i, blob] of blobs.entries()) {
      const listed = await capture('tar', ['--quoting-style=literal', '-tf', blob]);
      if (listed.status !== 0) {
        throw new CouldNotLook(`layer ${i} of ${ref} cannot be listed: ${failure(listed)}`);
      }
      scanLayerNames(footprint, i, listed.stdout.toString('utf8').split('\n'));
    }
    const folderNames = new Map();
    for (const [name, found] of footprint.folders) {
      const text = found === null ? null : await readMember(blobs[found.layer], found.member);
      folderNames.set(name, text === null ? null : packageNameOf(text));
    }
    const offenders = comparePresence(key, footprint, folderNames, expect);
    for (const file of footprint.npmrc) {
      for (const n of authLineNumbers(await readMember(blobs[file.layer], file.member))) {
        offenders.push(
          offender(key, 'npmrc', `${file.name} (layer ${file.layer}) line ${n} sets a credential`),
        );
      }
    }
    return offenders;
  } finally {
    cleanups.delete(remove);
    try {
      remove();
    } catch (error) {
      process.stderr.write(`channel-gate: cannot remove ${dir}: ${error.message}\n`);
    }
  }
}

async function readList(key, ref) {
  const name = `channel-gate-${process.pid}-${key}`;
  const remove = () => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  cleanups.add(remove);
  try {
    const args = ['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--name', name];
    args.push(
      '--entrypoint',
      'node',
      '-w',
      `/app/packages/${key}`,
      ref,
      '--input-type=module',
      '-',
    );
    const r = await capture('docker', args, { input: readerScript(key), timeout: READ_MS });
    if (r.status !== 0) {
      throw new CouldNotLook(`the module list of ${ref} cannot be read: ${failure(r)}`);
    }
    return parseReading(key, r.stdout.toString('utf8'));
  } finally {
    remove();
    cleanups.delete(remove);
  }
}

async function checkToken(key, ref, token) {
  const r = await capture('bash', [SCAN_IMAGE, ref], {
    env: { ...process.env, SCAN_TOKEN: token },
  });
  return compareToken(key, r);
}

async function checkImage(key, ref, env, expect, token) {
  const offenders = [];
  const couldNot = [];
  const attempt = async (what, check) => {
    try {
      offenders.push(...(await check()));
    } catch (error) {
      couldNot.push(`${key} ${what}: ${error.message}`);
    }
  };
  await attempt('layers', () => checkLayers(key, ref, expect));
  await attempt('lists', async () => compareLists(key, await readList(key, ref), expect));
  if (key !== 'web') offenders.push(...compareStamp(key, env, expect.version));
  await attempt('token', () => checkToken(key, ref, token));
  return { offenders, couldNot };
}

async function inspectEnv(ref) {
  const r = await capture('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', ref], {
    timeout: INSPECT_MS,
  });
  if (r.status !== 0) throw new CouldNotLook(`${ref} cannot be inspected: ${failure(r)}`);
  const env = JSON.parse(r.stdout.toString('utf8'));
  if (env !== null && !(Array.isArray(env) && env.every((entry) => typeof entry === 'string'))) {
    throw new CouldNotLook(`${ref} has an environment that cannot be read`);
  }
  return env ?? [];
}

export async function run(argv) {
  let expect;
  let token;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        expect: { type: 'string', multiple: true },
        'token-file': { type: 'string', multiple: true },
      },
      allowPositionals: false,
    });
    if (values.expect?.length !== 1 || values['token-file']?.length !== 1) {
      throw new CouldNotLook('exactly one --expect and one --token-file are needed');
    }
    expect = parseExpect(readFileSync(values.expect[0], 'utf8'));
    token = parseToken(readFileSync(values['token-file'][0], 'utf8'));
  } catch (error) {
    process.stderr.write(`channel-gate: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const scrub = (text) => text.split(token).join('[token]');
  const say = (text) => process.stderr.write(`channel-gate: ${scrub(text)}\n`);

  const images = KEYS.filter((key) => expect.images[key] !== undefined).map((key) => [
    key,
    expect.images[key],
  ]);
  const envs = new Map();
  const missing = [];
  for (const [key, ref] of images) {
    try {
      envs.set(key, await inspectEnv(ref));
    } catch (error) {
      missing.push(`${key}: ${error.message}`);
    }
  }
  if (missing.length > 0) {
    for (const line of missing) say(`could not look: ${line}`);
    return 2;
  }
  if (expect.images.web === undefined) say('no web image in the expectation, web is not checked');

  const offenders = [];
  const couldNot = [];
  for (const [key, ref] of images) {
    const result = await checkImage(key, ref, envs.get(key), expect, token);
    for (const o of result.offenders) process.stdout.write(`${scrub(formatOffender(o))}\n`);
    for (const line of result.couldNot) say(`could not look: ${line}`);
    offenders.push(...result.offenders);
    couldNot.push(...result.couldNot);
    say(
      `${key} ${ref}: ${result.offenders.length} offender(s), ${result.couldNot.length} check(s) not looked at`,
    );
  }
  const code = foldExit(offenders, couldNot);
  say(code === 0 ? 'every image passed every check' : `exit ${code}`);
  return code;
}

// Missing the match would run nothing and exit 0, so a symlinked or preserved path counts too.
function isEntryPoint() {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return [resolve(script), realpathSync(script)].some(
      (path) => pathToFileURL(path).href === import.meta.url,
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.on('exit', cleanUp);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(2));
  process.on('uncaughtException', (error) => {
    process.stderr.write(`channel-gate: unexpected error: ${error.message}\n`);
    process.exit(2);
  });
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
