import { spawn } from 'node:child_process';
import { normalizeCliArgsArray } from '@haive/shared';
import type {
  CliAuthMode,
  CliCommandSpec,
  CliProviderName,
  CliProviderRecord,
  CliRulesFileMode,
  EffortDecision,
  EffortScale,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
  ProbeResult,
  SteeringTransportContext,
  SubAgentInvocation,
  SubAgentSpec,
} from './types.js';

const DEFAULT_VERSION_TIMEOUT_MS = 5_000;

export abstract class BaseCliAdapter {
  abstract readonly providerName: CliProviderName;
  abstract readonly defaultExecutable: string;
  abstract readonly supportsSubagents: boolean;
  abstract readonly supportsCliAuth: boolean;
  abstract readonly supportsMcp: boolean;
  abstract readonly supportsPlugins: boolean;
  /** Whether this adapter exposes a usable language-server integration to the
   *  model. Defaults to false so test/custom adapters cannot accidentally
   *  advertise unavailable navigation tools. */
  readonly supportsLsp: boolean = false;
  abstract readonly defaultAuthMode: CliAuthMode;
  abstract readonly apiKeyEnvName: string | null;
  abstract readonly defaultModel: string | null;
  /** Path, relative to the repo root, where this CLI looks for its project-level
   *  rules. For AGENTS.md-native CLIs this is 'AGENTS.md' itself. */
  abstract readonly rulesFile: string;
  /** How step 07 should surface rules content to this CLI. See `CliRulesFileMode`. */
  abstract readonly rulesFileMode: CliRulesFileMode;
  /** Effort/reasoning scale exposed by this CLI, or null when the underlying
   *  CLI has no such knob. Adapters that override this MUST also override
   *  effortEnv() to translate a level into env vars. */
  readonly effortScale: EffortScale | null = null;
  /** Domains the CLI must reach for its OWN model/auth servers (e.g.
   *  api.anthropic.com). Merged at runtime with the provider's user-added
   *  egressDomains and fed into the egress gateway so the CLI works under
   *  network policy `none`/`allowlist`. Empty = adapter declares none (the
   *  user must add them per provider). */
  readonly defaultEgressDomains: readonly string[] = [];
  /** Whether this CLI supports mid-run steering: a live session into which the user can inject
   *  messages the CLI applies at its next boundary. The claude family and amp take them as
   *  stream-json lines on stdin; codex takes them over its app-server protocol. Default false. */
  readonly supportsSteering: boolean = false;

  /** Whether that steering transport can be used for THIS provider in THIS task. The capability
   *  above is static; this is the per-task half. A transport of stdin NDJSON lines is always
   *  spoken, so the default is true. codex overrides it: its transport is the experimental
   *  app-server, which a task relies on only once it was verified for that provider's binary
   *  (cli-adapters/codex-app-server-verdict.ts). Read in one place, the dispatcher, ANDed with
   *  supportsSteering and the step's steering request. */
  steeringTransportReady(_provider: CliProviderRecord, _ctx: SteeringTransportContext): boolean {
    return true;
  }

  async isAvailable(provider: CliProviderRecord): Promise<boolean> {
    const result = await this.probeExecutable(provider);
    return result.ok;
  }

  async probeExecutable(provider: CliProviderRecord): Promise<ProbeResult> {
    const executable = this.resolveExecutable(provider);
    return probeVersion(executable);
  }

  abstract buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec;

  buildSubAgentInvocation(
    _provider: CliProviderRecord,
    spec: SubAgentSpec,
    _opts: InvokeOpts,
  ): SubAgentInvocation {
    return {
      mode: 'native',
      steps: spec.subAgents.map((sub) => ({
        id: sub.name,
        prompt: sub.prompt,
        expectJsonOutput: true,
        collectInto: sub.outputKey,
      })),
      synthesis: {
        id: 'synthesis',
        prompt: spec.synthesisPrompt,
        expectJsonOutput: true,
      },
    };
  }

  abstract envInjection(provider: CliProviderRecord): EnvInjection;

  buildPluginInstallCommands?(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[];

  /** Env vars to inject for the given effort level. Default: none. Override
   *  per-adapter when the underlying CLI supports an effort/budget knob
   *  (e.g. CLAUDE_CODE_EFFORT_LEVEL). The level passed in is guaranteed to
   *  be a member of effortScale.values when effortScale is non-null. */
  effortEnv(_level: string): Record<string, string> {
    return {};
  }

  /** Env vars an interactive shell (terminal tab) should see for this
   *  provider — provider.envVars + effort + decrypted secrets. Adapters
   *  that remap keys for their CLI binary (zai aliases ANTHROPIC_AUTH_TOKEN
   *  off Z_AI_API_KEY) override this so a manual `claude` invocation in
   *  the shell sees the same env the orchestrator would pass. */
  buildShellEnv(
    provider: CliProviderRecord,
    secrets: Record<string, string>,
    extraEnv: Record<string, string> = {},
  ): Record<string, string> {
    const effort = this.resolveEffortEnv(provider, {});
    return { ...(provider.envVars ?? {}), ...effort, ...secrets, ...extraEnv };
  }

  protected resolveExecutable(provider: CliProviderRecord): string {
    const wrapper = provider.wrapperPath?.trim();
    if (wrapper) return wrapper;
    const explicit = provider.executablePath?.trim();
    if (explicit) return explicit;
    return this.defaultExecutable;
  }

  protected mergedEnv(provider: CliProviderRecord, opts: InvokeOpts): Record<string, string> {
    const effort = this.resolveEffortEnv(provider, opts);
    return { ...(provider.envVars ?? {}), ...effort, ...(opts.extraEnv ?? {}) };
  }

  /** Resolution order: explicit InvokeOpts.effortLevel wins, then the
   *  per-provider stored effortLevel, then the adapter's effortScale.max.
   *  Adapters with effortScale=null always return null. Unknown level values
   *  (e.g. a stale DB row) are dropped rather than returned, so a poisoned
   *  value never reaches the CLI. Shared by env-based effort (claude-code,
   *  zai) and arg-based effort (codex). */
  protected resolveEffortLevel(provider: CliProviderRecord, opts: InvokeOpts): string | null {
    const scale = this.effortScale;
    if (!scale) return null;
    const candidate = opts.effortLevel ?? provider.effortLevel ?? scale.max;
    if (!scale.values.includes(candidate)) return null;
    return candidate;
  }

  /** The effort level that actually reaches the CLI, and its provenance — the recorded form of
   *  the same decision resolveEffortLevel makes, so there is ONE resolution rule rather than a
   *  second one at the recording site.
   *
   *  Reports what was SENT, not what was asked for: an out-of-scale level is dropped before it
   *  reaches the CLI, so a stale preference row naming a level this adapter does not have is
   *  recorded as the fallback that actually ran, never as the level nobody honoured. */
  effortDecision(provider: CliProviderRecord, opts: InvokeOpts = {}): EffortDecision {
    if (!this.effortScale) return { level: null, source: 'none' };
    const level = this.resolveEffortLevel(provider, opts);
    // A scale exists but nothing resolved: the only way that happens is a configured level this
    // adapter does not have, which resolveEffortLevel drops rather than forwards. Recorded as
    // its own source because the run then used the CLI's own default and nobody was told.
    if (level === null) return { level: null, source: 'dropped' };
    if (opts.effortLevel === level) return { level, source: 'step' };
    if (provider.effortLevel === level) return { level, source: 'provider' };
    return { level, source: 'scale_max' };
  }

  protected resolveEffortEnv(
    provider: CliProviderRecord,
    opts: InvokeOpts,
  ): Record<string, string> {
    const level = this.resolveEffortLevel(provider, opts);
    if (!level) return {};
    return this.effortEnv(level);
  }

  protected mergedArgs(provider: CliProviderRecord, base: string[]): string[] {
    // Re-tokenize stored args so DB rows written before
    // shell-tokenize learnt the `--flag="value"` form (embedded `=` and
    // wrapping quotes) get healed at spawn time without forcing the user
    // to re-save the CLI provider. Idempotent on already-normalized input.
    const stored = normalizeCliArgsArray(provider.cliArgs ?? []);
    // Base goes last, so the CLI's last-flag-wins settles any flag both lists set.
    return [...dropArgsAlreadyInBase(stored, base), ...base];
  }
}

const FLAG_TOKEN = /^--?[A-Za-z]/;

/** Stored args minus what `base` already passes, judged by how base uses each flag: one it passes
 *  alone goes as a duplicate boolean, one it passes with a value only as that exact pair. Never a
 *  lone token — dropping a flag while keeping its value strands the value as a positional. */
export function dropArgsAlreadyInBase(stored: string[], base: string[]): string[] {
  const booleans = new Set<string>();
  const valued = new Set<string>();
  const pairs = new Set<string>();
  for (let i = 0; i < base.length; i++) {
    const tok = base[i]!;
    if (!FLAG_TOKEN.test(tok)) continue;
    const next = base[i + 1];
    if (next === undefined || FLAG_TOKEN.test(next)) {
      booleans.add(tok);
    } else {
      valued.add(tok);
      pairs.add(JSON.stringify([tok, next]));
    }
  }
  const kept: string[] = [];
  for (let i = 0; i < stored.length; i++) {
    const tok = stored[i]!;
    if (booleans.has(tok)) continue;
    const next = stored[i + 1];
    if (valued.has(tok) && next !== undefined && !FLAG_TOKEN.test(next)) {
      if (!pairs.has(JSON.stringify([tok, next]))) kept.push(tok, next);
      i++;
      continue;
    }
    kept.push(tok);
  }
  return kept;
}

export async function probeVersion(
  executable: string,
  args: string[] = ['--version'],
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, version: stdout.trim() || stderr.trim() || undefined });
      } else {
        finish({ ok: false, error: stderr.trim() || `exit ${code ?? 'unknown'}` });
      }
    });
  });
}
