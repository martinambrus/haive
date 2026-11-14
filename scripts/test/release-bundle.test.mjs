import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RELEASE_BUNDLE_FILES } from '../../packages/shared/src/release/manifest.ts';
import { readWorkflow } from './workflow.mjs';

const workflow = readWorkflow('release.yml');
const job = workflow.jobs.release;
const manifestStep = job.steps.find((step) => step.name === 'Build the release manifest');
const buildStep = job.steps.find((step) => step.name === 'Build and push the release bundle');
const digestStep = job.steps.find((step) => step.name === 'Report the release bundle digest');
const createStep = job.steps.find((step) => step.run?.includes('gh release create'));
const digest = `sha256:${'a'.repeat(64)}`;
const hash = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;

test('manifest checkout includes complete history and tags, Node 26 and schema dependencies', () => {
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with?.['fetch-depth'], '0');
  assert.equal(checkout.with?.['fetch-tags'], 'true');
  assert.ok(
    job.steps.some(
      (step) => step.uses?.startsWith('actions/setup-node@') && step.with['node-version'] === '26',
    ),
  );
  assert.ok(
    job.steps.some(
      (step) =>
        step.run?.includes('pnpm') &&
        step.run.includes('--frozen-lockfile') &&
        step.run.includes('@haive/shared'),
    ),
  );
});

test('release bundle push and digest re-read gate GitHub Release creation for both platforms', () => {
  assert.equal(job.needs, 'merge');
  assert.equal(job.permissions.packages, 'write');
  assert.ok(job.steps.some((step) => step.uses?.startsWith('docker/setup-buildx-action@')));
  for (const step of [manifestStep, buildStep, digestStep]) {
    assert.ok(step, 'bundle publication step exists');
    assert.ok(job.steps.indexOf(step) < job.steps.indexOf(createStep));
    assert.ok(!step.if && !step['continue-on-error'], 'failure must stop the release');
    assert.match(step.run, /set -euo pipefail/);
  }
  assert.ok(job.steps.indexOf(manifestStep) < job.steps.indexOf(buildStep));
  assert.ok(job.steps.indexOf(buildStep) < job.steps.indexOf(digestStep));
  assert.match(
    buildStep.run,
    /docker buildx build[\s\S]*--platform linux\/amd64,linux\/arm64[\s\S]*--push/,
  );
  assert.match(buildStep.run, /\$\{IMAGE_PREFIX\}-release:\$\{VERSION\}/);
  assert.match(digestStep.run, /docker buildx imagetools inspect/);
  for (const step of job.steps.filter((step) => step.uses))
    assert.match(step.uses, /@[0-9a-f]{40}$/);
});

function fixture(t, failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'release-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const temp = join(root, 'tmp');
  mkdirSync(bin);
  mkdirSync(temp);
  mkdirSync(join(root, 'install'));
  const files = Object.fromEntries(RELEASE_BUNDLE_FILES.map((name) => [name, `${name}\r\n`]));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  writeFileSync(join(root, 'install/bundle-env.json'), '[]');
  writeFileSync(join(root, '.env'), 'excluded\n');
  writeFileSync(join(root, 'docker-compose.dev.yml'), 'excluded\n');
  const capture = join(root, 'commands.jsonl');
  const executable = (name, source) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${source}`);
    chmodSync(path, 0o700);
  };
  executable(
    'node',
    `
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const args=process.argv.slice(2), dir=args[args.indexOf('--bundle-dir')+1];
if (!args.includes('--bundle-dir') || !dir) process.exit(7);
const env=JSON.parse(readFileSync(join(dir,'install/bundle-env.json'),'utf8'));
const files=Object.fromEntries(readdirSync(dir).filter(name=>name.endsWith('.yml')).map(name=>[name,'sha256:'+createHash('sha256').update(readFileSync(join(dir,name))).digest('hex')]));
for (const name of Object.keys(files)) writeFileSync(name,'changed after snapshot');
process.stdout.write(JSON.stringify({bundle:{files,env}}));
`,
  );
  executable(
    'docker',
    `
import {appendFileSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
let payload={args};
if(args[0]==='buildx' && args[1]==='build') {
 const context=args.at(-1);
 payload={...payload,files:readdirSync(context).sort(),bundle:Object.fromEntries(readdirSync(join(context,'bundle')).map(name=>[name,readFileSync(join(context,'bundle',name),'utf8')])),manifest:JSON.parse(readFileSync(join(context,'release.json'),'utf8')),dockerfile:readFileSync(args[args.indexOf('--file')+1],'utf8')};
}
appendFileSync(${JSON.stringify(capture)},JSON.stringify(payload)+'\\n');
if(${JSON.stringify(failure)}==='push' && args[1]==='build') process.exit(8);
if(args[2]==='inspect') {
 if(args[3]?.includes('-release:') && ${JSON.stringify(failure)}==='inspect') process.exit(9);
 process.stdout.write(args[3]?.includes('-release:') && ${JSON.stringify(failure)}==='digest' ? 'invalid' : ${JSON.stringify(digest)});
}
`,
  );
  executable(
    'gh',
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(capture)},JSON.stringify({gh:process.argv.slice(2)})+'\\n');`,
  );
  return {
    root,
    files,
    capture,
    execute: (steps) =>
      spawnSync('bash', ['-e', '-o', 'pipefail', '-c', steps.map((step) => step.run).join('\n')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_REF_NAME: 'v9.9.9',
          REGISTRY: 'ghcr.io',
          IMAGE_PREFIX: 'example/haive',
        },
      }),
  };
}

test('workflow shell publishes exactly the hashed snapshot and attaches the same manifest', (t) => {
  assert.ok(buildStep && digestStep, 'bundle steps exist');
  const f = fixture(t);
  const result = f.execute([manifestStep, buildStep, digestStep, createStep]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = readFileSync(f.capture, 'utf8').trim().split('\n').map(JSON.parse);
  const built = calls.find((call) => call.args?.[1] === 'build');
  assert.deepEqual(built.files, ['bundle', 'release.json']);
  assert.deepEqual(built.bundle, f.files);
  assert.deepEqual(
    built.manifest.bundle.files,
    Object.fromEntries(Object.entries(f.files).map(([name, body]) => [name, hash(body)])),
  );
  assert.equal(
    built.dockerfile,
    'FROM scratch\nCOPY release.json /release.json\nCOPY bundle/ /bundle/\nLABEL org.haive.release=1\n',
  );
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'release.json'), 'utf8')), built.manifest);
  assert.ok(built.args.includes('--push'));
  assert.equal(built.args[built.args.indexOf('--platform') + 1], 'linux/amd64,linux/arm64');
  assert.ok(calls.at(-1).gh.includes('create'));
});

for (const failure of ['push', 'inspect', 'digest']) {
  test(`workflow shell stops before GitHub Release creation on ${failure} failure`, (t) => {
    assert.ok(buildStep && digestStep, 'bundle steps exist');
    const f = fixture(t, failure);
    const result = f.execute([manifestStep, buildStep, digestStep, createStep]);
    assert.notEqual(result.status, 0);
    assert.ok(!readFileSync(f.capture, 'utf8').includes('"gh":'));
  });
}
