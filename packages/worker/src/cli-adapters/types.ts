import { schema } from '@haive/database';

export type CliProviderRecord = typeof schema.cliProviders.$inferSelect;
export type CliProviderName = CliProviderRecord['name'];
export type CliAuthMode = CliProviderRecord['authMode'];

export interface InvokeOpts {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>;
  sessionId?: string;
  nonInteractive?: boolean;
  /** Per-call override for reasoning/effort level. Must be a value from the
   *  adapter's effortScale. When unset the adapter falls back to
   *  provider.effortLevel, then to the adapter's effortScale.max. Adapters
   *  with effortScale=null ignore this option. */
  effortLevel?: string;
  /** When true, a steering-capable (Claude-family) adapter builds an interactive
   *  stream-json INPUT invocation (prompt on stdin, mid-run steering) instead of
   *  the one-shot `-p "<prompt>"` form. Set by the dispatcher only when steering
   *  is enabled (global + per-repo) AND the adapter supportsSteering. Other
   *  adapters ignore it. */
  steeringMode?: boolean;
  /** Claude-family only: tool names passed to `--disallowedTools` (a deny-list;
   *  deny beats allow and is honored even under --dangerously-skip-permissions).
   *  Set for onboarding mining invocations to `['Agent']` so a mining agent cannot
   *  spawn its own Claude Code sub-agents (uncontrolled token fan-out). Non-claude
   *  adapters ignore it. */
  disallowedTools?: string[];
}

export interface EffortScale {
  /** Allowed level identifiers for this CLI, ordered low-to-high. */
  values: readonly string[];
  /** Identifier corresponding to the highest effort. Used as the default
   *  when no per-provider override is set. */
  max: string;
}

/** How step 07 surfaces per-CLI rules content to this CLI:
 *   - 'native': CLI auto-reads AGENTS.md. Content is appended directly to AGENTS.md.
 *   - 'import': CLI reads its own file but supports `@AGENTS.md` syntax. The file
 *     receives an `@AGENTS.md` line plus this CLI's own rules block.
 *   - 'copy': CLI reads its own file and has no import syntax. The file receives
 *     only this CLI's own rules block. */
export type CliRulesFileMode = 'native' | 'import' | 'copy';

/** How exec-core / the sequential sub-agent runner should interpret the CLI's
 *  stdout. Undefined = legacy heuristic (claude NDJSON collector probe). */
export type CliOutputFormat = 'plain' | 'claude-stream-json' | 'codex-jsonl' | 'gemini-json';

export interface CliCommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  outputFormat?: CliOutputFormat;
  /** Steerable invocation: the spawner opens an interactive stdin pipe and
   *  writes `stdinInitial`, and exec-core wires a Redis steer channel into it.
   *  Set by Claude-family adapters in steering mode. */
  steerable?: boolean;
  /** Written to the CLI's stdin immediately after start (the prompt as an NDJSON
   *  user-message). Only present when steerable. */
  stdinInitial?: string;
  /** When set, the sandbox runner mounts a WRITABLE directory at
   *  `captureFile.containerDir` and, after the run, reads `<containerDir>/<fileName>`
   *  back out as `CliExecutionResult.capturedLog`. Used to recover a CLI's own log
   *  file out of the `--rm` sandbox — agy (antigravity) writes provider-fatal errors
   *  (quota/auth/5xx) ONLY to its log and exits 0 with empty output, so that log is
   *  the sole classifiable signal. Set by the antigravity adapter alongside its
   *  `--log-file` arg; no other adapter uses it. */
  captureFile?: { containerDir: string; fileName: string };
}

export interface SubAgent {
  name: string;
  prompt: string;
  outputKey: string;
}

export interface SubAgentSpec {
  subAgents: SubAgent[];
  synthesisPrompt: string;
}

export type SubAgentInvocationMode = 'native' | 'sequential';

export interface SubAgentInvocationStep {
  id: string;
  prompt: string;
  expectJsonOutput: boolean;
  collectInto?: string;
}

export interface SubAgentInvocation {
  mode: SubAgentInvocationMode;
  steps: SubAgentInvocationStep[];
  synthesis: SubAgentInvocationStep;
}

export interface EnvInjection {
  envVars: Record<string, string>;
  extraArgs: string[];
}

export interface ProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export type LspLanguage = 'typescript' | 'python' | 'go' | 'rust' | 'php' | 'php-extended' | 'java';

export interface PluginInstallOpts {
  repoRoot: string;
  lspLanguages: LspLanguage[];
  drupalLspPath?: string;
}

export interface PluginInstallCommand {
  description: string;
  command: string;
  args: string[];
}
