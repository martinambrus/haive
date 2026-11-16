import { logger } from '@haive/shared';
import { resourceLimitsEnabled } from './runtime-caps.js';
import { shellQuote } from './shell-quote.js';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';

export type SandboxToolchainFact =
  { imageId: string; php: 'absent' } | { imageId: string; php: 'found'; version?: string };

const log = logger.child({ module: 'toolchain-probe' });

export const TOOLCHAIN_UNKNOWN_TTL_MS = 60_000;
export const TOOLCHAIN_CACHE_LIMIT = 128;
export const TOOLCHAIN_MAX_CONCURRENT = 2;
export const TOOLCHAIN_PROBE_TIMEOUT_MS = 1_500;
export const TOOLCHAIN_OUTPUT_LIMIT_BYTES = 1_024;
export const IMMUTABLE_IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

// The script owns 199. A raw shell error (including no shell) never proves absence.
const PHP_DISCOVERY =
  "if command -v php >/dev/null 2>&1; then php -n -r 'echo PHP_VERSION;' 2>/dev/null; exit 0; else exit 199; fi";

// The container must expire even if its Docker client or worker dies. Prefer timeout;
// the fallback watchdog kills PID 1, which also ends its container's descendants.
const PHP_PROBE = [
  'if command -v timeout >/dev/null 2>&1; then',
  `  exec timeout -s KILL 1 /bin/sh -c ${shellQuote(PHP_DISCOVERY)}`,
  'fi',
  'parent=$$',
  '( sleep 1; kill -KILL "$parent" ) &',
  'watchdog=$!',
  `trap 'kill "$watchdog" 2>/dev/null || :' EXIT`,
  PHP_DISCOVERY,
].join('\n');

/** One shared, bounded cache per worker. In-flight entries are never evicted: evicting one
 * would let another fan-out start the same container again. Saturation answers unknown,
 * with no waiting queue. A slot remains held through DockerRunner's awaited timeout cleanup. */
export class SandboxToolchainProbe {
  private readonly entries = new Map<
    string,
    { promise: Promise<SandboxToolchainFact | null>; settled: boolean; expiresAt: number }
  >();
  private active = 0;
  constructor(
    private readonly runner: DockerRunner = defaultDockerRunner,
    private readonly limits: {
      cacheLimit?: number;
      maxConcurrent?: number;
      timeoutMs?: number;
      outputLimitBytes?: number;
      unknownTtlMs?: number;
    } = {},
  ) {}

  get(imageId: string): Promise<SandboxToolchainFact | null> {
    if (!IMMUTABLE_IMAGE_ID.test(imageId)) return Promise.resolve(null);
    const hit = this.entries.get(imageId);
    if (hit && (!hit.settled || hit.expiresAt > Date.now())) {
      this.entries.delete(imageId);
      this.entries.set(imageId, hit);
      return hit.promise;
    }
    if (hit) this.entries.delete(imageId);
    const cap = this.limits.cacheLimit ?? TOOLCHAIN_CACHE_LIMIT;
    if (this.active >= (this.limits.maxConcurrent ?? TOOLCHAIN_MAX_CONCURRENT) || cap <= 0)
      return Promise.resolve(null);
    if (this.entries.size >= cap) {
      const oldest = [...this.entries].find(([, entry]) => entry.settled);
      if (!oldest) return Promise.resolve(null);
      this.entries.delete(oldest[0]);
    }
    this.active++;
    const entry = {
      promise: Promise.resolve(null) as Promise<SandboxToolchainFact | null>,
      settled: false,
      expiresAt: Infinity,
    };
    entry.promise = this.run(imageId)
      .catch(() => this.unknown(imageId, null, false))
      .then((fact) => {
        this.active--;
        entry.settled = true;
        if (fact === null)
          entry.expiresAt = Date.now() + (this.limits.unknownTtlMs ?? TOOLCHAIN_UNKNOWN_TTL_MS);
        return fact;
      });
    this.entries.set(imageId, entry);
    return entry.promise;
  }

  private async run(imageId: string): Promise<SandboxToolchainFact | null> {
    const capped = await resourceLimitsEnabled({ strict: true });
    const result = await this.runner.run({
      image: imageId,
      entrypoint: '/bin/sh',
      cmd: ['-c', PHP_PROBE],
      user: 'node',
      workdir: '/haive/workdir',
      network: 'none',
      readOnly: true,
      pull: 'never',
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      maxOutputBytes: this.limits.outputLimitBytes ?? TOOLCHAIN_OUTPUT_LIMIT_BYTES,
      ...(capped ? { memoryLimitMb: 64, cpuLimitMilli: 250, pidsLimit: 16 } : {}),
      labels: { 'haive.toolchain-probe': '1' },
      timeoutMs: this.limits.timeoutMs ?? TOOLCHAIN_PROBE_TIMEOUT_MS,
    });
    if (result.timedOut || result.error)
      return this.unknown(imageId, result.exitCode, result.timedOut);
    if (result.exitCode === 199) return { imageId, php: 'absent' };
    if (result.exitCode !== 0) return this.unknown(imageId, result.exitCode, result.timedOut);
    // Dockerfile-authored stdout is data. Only a small version alphabet enters a prompt.
    const version = result.stdout.trim();
    return {
      imageId,
      php: 'found',
      ...(/^\d{1,2}\.\d{1,2}\.\d{1,2}(?:[a-zA-Z0-9.+-]{0,24})?$/.test(version) ? { version } : {}),
    };
  }
  private unknown(imageId: string, exitCode: number | null, timedOut: boolean): null {
    log.warn({ imageId, exitCode, timedOut }, 'sandbox toolchain probe returned unknown');
    return null;
  }
}

export const sandboxToolchainProbe = new SandboxToolchainProbe();
