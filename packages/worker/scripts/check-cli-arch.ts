#!/usr/bin/env tsx
/**
 * Does every CLI adapter install and run on this machine's architecture?
 *
 * `frictionless-bootstrapping-otter`'s verification item 8 asks that each CLI the image-composer
 * can layer either installs and runs on arm64, or is reported as unavailable there with a named
 * reason. This produces that report by MEASURING — it composes each provider exactly the way the
 * worker does at runtime (`composeSandboxImage` over the real `CLI_INSTALL_METADATA`), builds the
 * image and runs the binary.
 *
 * It is not a macOS test, and that distinction is the point. The CLIs install into
 * `node:24-bookworm-slim`, a LINUX container, so on an Apple Silicon Mac they run linux/arm64 —
 * the same thing a native arm64 Linux runner gives us for free. The host OS never enters into it.
 *
 * Exit 0 when every adapter either works or is a declared exception; exit 1 on an UNDECLARED
 * failure, which is the regression this guards.
 *
 *   pnpm --filter @haive/worker exec tsx scripts/check-cli-arch.ts [--only <name>] [--keep]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arch } from 'node:process';
import { CLI_INSTALL_METADATA, cliProviderNameSchema, type CliProviderName } from '@haive/shared';
import { composeSandboxImage, SANDBOX_CORE_IMAGE } from '../src/sandbox/image-composer.js';
import { buildProviderInstallLines } from '../src/cli-versions/codegen.js';

/**
 * CLIs known not to ship a build for an architecture, with the reason.
 *
 * Deliberately EMPTY until a measurement puts something here — the point of this script is to
 * find out, and a pre-populated list would be a guess wearing a fact's clothing. When an entry
 * does earn its place, the declaration belongs in `CLI_INSTALL_METADATA` rather than here, so the
 * product can stop offering that provider on that host instead of only CI knowing about it.
 */
const DECLARED_UNAVAILABLE: Partial<Record<CliProviderName, Partial<Record<string, string>>>> = {};

type Verdict = 'ok' | 'failed' | 'declared' | 'piggyback' | 'unsupported';
interface Result {
  name: CliProviderName;
  verdict: Verdict;
  detail: string;
}

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const keep = args.includes('--keep');
const dockerArch = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : arch;

function run(cmd: string, cmdArgs: string[], cwd?: string): { code: number; out: string } {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The last line that looks like an error, for a one-line report entry. */
function lastMeaningfulLine(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const err = [...lines]
    .reverse()
    .find((l) => /error|not found|unsupported|no such|denied/i.test(l));
  return (err ?? lines.at(-1) ?? 'no output').slice(0, 200);
}

function buildBase(): void {
  console.log(`\n==> Building ${SANDBOX_CORE_IMAGE} for linux/${dockerArch}`);
  const dir = join(import.meta.dirname, '..', 'sandbox-image');
  const r = run('docker', ['build', '-t', SANDBOX_CORE_IMAGE, dir]);
  if (r.code !== 0) {
    console.error(r.out.split('\n').slice(-25).join('\n'));
    throw new Error('sandbox base image build failed — nothing else can be measured');
  }
  console.log('    base image ready');
}

function checkProvider(name: CliProviderName): Result {
  const meta = CLI_INSTALL_METADATA[name];
  const kind = meta.install.kind;

  // A piggyback adapter installs nothing of its own — it points the claude binary at another
  // endpoint — so there is no separate arch surface to measure.
  if (kind === 'piggyback') {
    return { name, verdict: 'piggyback', detail: 'installs nothing; covered by claude-code' };
  }
  if (kind === 'unsupported' || !buildProviderInstallLines(name, null).supported) {
    return { name, verdict: 'unsupported', detail: 'declared unsupported in CLI_INSTALL_METADATA' };
  }

  const composition = composeSandboxImage({
    envTemplateDockerfile: null,
    provider: { name, cliVersion: null, sandboxDockerfileExtra: null },
  });

  const dir = mkdtempSync(join(tmpdir(), `haive-arch-${name}-`));
  try {
    writeFileSync(join(dir, 'Dockerfile'), composition.dockerfileBody);
    const tag = `haive-archcheck-${name}:latest`;
    const build = run('docker', ['build', '-t', tag, dir]);
    if (build.code !== 0) {
      const declared = DECLARED_UNAVAILABLE[name]?.[dockerArch];
      if (declared) return { name, verdict: 'declared', detail: declared };
      return { name, verdict: 'failed', detail: `build: ${lastMeaningfulLine(build.out)}` };
    }

    // Building proves it installed; running proves the binary is for THIS architecture. An
    // npm package with a per-platform optional dependency installs happily and then dies with
    // "Exec format error", which is exactly the failure this item exists to catch.
    const binary = 'binary' in meta.install ? meta.install.binary : null;
    if (binary) {
      const ver = run('docker', ['run', '--rm', '--entrypoint', binary, tag, '--version']);
      if (!keep) run('docker', ['rmi', '-f', tag]);
      if (ver.code !== 0) {
        const declared = DECLARED_UNAVAILABLE[name]?.[dockerArch];
        if (declared) return { name, verdict: 'declared', detail: declared };
        return { name, verdict: 'failed', detail: `run: ${lastMeaningfulLine(ver.out)}` };
      }
      return { name, verdict: 'ok', detail: ver.out.trim().split('\n')[0]?.slice(0, 80) ?? '' };
    }
    if (!keep) run('docker', ['rmi', '-f', tag]);
    return { name, verdict: 'ok', detail: 'installed (no version command declared)' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const names = cliProviderNameSchema.options.filter((n) => !only || n === only);
console.log(`CLI adapter architecture check — linux/${dockerArch} (node ${process.version})`);
buildBase();

const results: Result[] = [];
for (const name of names) {
  process.stdout.write(`\n==> ${name} … `);
  const r = checkProvider(name);
  results.push(r);
  console.log(r.verdict.toUpperCase());
  if (r.detail) console.log(`    ${r.detail}`);
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\n${'='.repeat(72)}\nlinux/${dockerArch} summary\n${'='.repeat(72)}`);
for (const r of results) {
  console.log(`  ${r.name.padEnd(width)}  ${r.verdict.padEnd(11)}  ${r.detail}`);
}

const undeclared = results.filter((r) => r.verdict === 'failed');
if (undeclared.length > 0) {
  console.error(
    `\n${undeclared.length} adapter(s) failed on linux/${dockerArch} without a declared reason: ` +
      `${undeclared.map((r) => r.name).join(', ')}.\n` +
      `Either fix the install, or declare it — item 8 asks for a NAMED reason, not silence.`,
  );
  process.exit(1);
}
console.log(`\nAll ${results.length} adapters accounted for on linux/${dockerArch}.`);
