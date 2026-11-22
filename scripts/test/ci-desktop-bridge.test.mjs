import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readWorkflow } from './workflow.mjs';

const ci = readWorkflow('ci.yml');
const guard = "${{ !cancelled() && steps.prepare.conclusion == 'success' }}";

test('desktop bridge has an independent, bounded Go job using the Dockerfile toolchain', () => {
  const job = ci.jobs['desktop-bridge-go'];
  assert.ok(job, 'desktop bridge Go checks need a CI job');
  const dockerfile = readFileSync(
    new URL('../../docker/desktop-extension/Dockerfile', import.meta.url),
    'utf8',
  );
  const image = dockerfile.match(/golang:[^\s@]+@sha256:[a-f\d]{64}/)?.[0];
  assert.ok(image);
  assert.equal(job.env.GO_IMAGE, image);
  assert.equal(job.needs, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.ok(Number(job['timeout-minutes']) > 0 && Number(job['timeout-minutes']) <= 15);
  assert.match(job.steps[0].uses, /^actions\/checkout@[a-f\d]{40}$/);
  assert.equal(job.steps[0].with['fetch-depth'], '0');
  for (const step of job.steps) {
    assert.ok(Number(step['timeout-minutes']) >= 2);
    assert.ok(Number(step['timeout-minutes']) < Number(job['timeout-minutes']));
    assert.equal(step['continue-on-error'], undefined);
  }
});

test('path detection covers the bridge, embedded installers and the checks themselves', () => {
  const job = ci.jobs['desktop-bridge-go'];
  assert.ok(job);
  const changes = job.steps.find((step) => step.id === 'changes');
  assert.ok(changes);
  assert.equal(
    changes.env.BASE_SHA,
    '${{ github.event.pull_request.base.sha || github.event.before }}',
  );
  assert.match(changes.run, /git diff --name-only "\$BASE_SHA" HEAD --/);
  for (const path of [
    'docker/desktop-extension/bridge/',
    'docker/desktop-extension/Dockerfile',
    'install/install.sh',
    'install/install.ps1',
    '.github/workflows/ci.yml',
    'scripts/test/ci-desktop-bridge.test.mjs',
  ])
    assert.ok(changes.run.includes(path), path);
  assert.match(changes.run, /0000000000000000000000000000000000000000/);
  assert.match(changes.run, /changed=true/);
  assert.match(changes.run, /changed=false/);
  assert.match(changes.run, /GITHUB_OUTPUT/);
  const prepare = job.steps.find((step) => step.id === 'prepare');
  assert.equal(prepare.if, "steps.changes.outputs.changed == 'true'");
  assert.match(prepare.run, /scripts\/ci-retry\.sh docker pull "\$GO_IMAGE"/);
});

test('format, cross-platform vet and tests run independently with read-only sources and limits', () => {
  const job = ci.jobs['desktop-bridge-go'];
  assert.ok(job);
  const checks = job.steps.slice(job.steps.findIndex((step) => step.id === 'prepare') + 1);
  assert.equal(checks.length, 3);
  for (const step of checks) {
    assert.equal(step.if, guard);
    assert.match(step.run, /docker run --rm --cpus=2 --memory=1g/);
    assert.match(step.run, /-e CGO_ENABLED=0 -e GOMAXPROCS=2/);
    assert.match(step.run, /desktop-extension:\/src:ro/);
    assert.match(step.run, /install:\/install:ro/);
    assert.match(step.run, /-w \/src\/bridge "\$GO_IMAGE" sh -ec/);
    assert.match(step.run, /cp -R \/src\/bridge \/tmp\/bridge/);
    assert.match(
      step.run,
      /cp \/install\/install\.sh \/install\/install\.ps1 \/tmp\/bridge\/install\//,
    );
    assert.match(step.run, /cd \/tmp\/bridge/);
  }
  const format = checks.find((step) => step.name === 'Go format');
  assert.match(format.run, /files=\$\(gofmt -l \.\)/);
  assert.match(format.run, /if \[ -n "\$files" \]; then/);
  assert.match(format.run, /exit 1/);
  const vet = checks.find((step) => step.name === 'Go vet');
  assert.match(vet.run, /for os in linux windows darwin; do/);
  assert.match(vet.run, /for arch in amd64 arm64; do/);
  assert.match(vet.run, /GOOS=\$os GOARCH=\$arch go vet -p 1 \.\/\.\.\. \|\| exit 1/);
  assert.match(checks.find((step) => step.name === 'Go test').run, /go test -p 1 -v \.\/\.\.\./);
});

test('the real change detector skips unrelated commits and fails closed on an unavailable base', (t) => {
  const job = ci.jobs['desktop-bridge-go'];
  assert.ok(job);
  const script = job.steps.find((step) => step.id === 'changes').run;
  const dir = mkdtempSync(join(tmpdir(), 'ci-desktop-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=CI',
        '-c',
        'user.email=ci@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    ).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const initialBase = git('rev-parse', 'HEAD');
  const output = join(dir, 'output');
  const detect = (base) => {
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: output },
    });
    return { ...result, output: readFileSync(output, 'utf8').trim() };
  };
  for (const [path, changed] of [
    ['unrelated.txt', false],
    ['docker/desktop-extension/ui/app.js', false],
    ['docker/desktop-extension/bridge/main.go', true],
    ['install/install.sh', true],
    ['install/install.ps1', true],
    ['docker/desktop-extension/Dockerfile', true],
    ['.github/workflows/ci.yml', true],
    ['scripts/ci-retry.sh', true],
    ['scripts/test/ci-desktop-bridge.test.mjs', true],
  ]) {
    const base = git('rev-parse', 'HEAD');
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), 'changed');
    git('add', '--', path);
    git('commit', '-q', '-m', 'change');
    const result = detect(base);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `changed=${changed}`, path);
  }
  assert.equal(detect(initialBase).output, 'changed=true', 'multi-commit changes stay covered');
  for (const base of ['', '0000000000000000000000000000000000000000']) {
    assert.equal(detect(base).output, 'changed=true', 'a new branch runs the checks');
  }
  const missing = detect('unavailable-base');
  assert.notEqual(missing.status, 0, 'a failed diff must fail the detector');
  assert.equal(missing.output, '', 'a failed diff must not claim nothing changed');
});
