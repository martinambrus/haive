import { schema } from '@haive/database';
import type { CodexAppServerVerdicts } from './codex-app-server-verdict.js';

export type CliProviderRecord = typeof schema.cliProviders.$inferSelect;
export type CliProviderName = CliProviderRecord['name'];
export type CliAuthMode = CliProviderRecord['authMode'];

/** The reasoning-effort level that actually reached the CLI, and where it came from.
 *
 *  Recorded per invocation because nothing else keeps it: the level is resolved at spawn and
 *  then discarded, and the per-step preference row holds only its CURRENT value, so its next
 *  write erases what past runs used.
 *
 *  `source` is load-bearing, not descriptive. An adapter whose scale.max is 'high' produces the
 *  same LEVEL whether a human chose it or nobody did, and a model comparison cannot read a
 *  deliberate setting off a default. The two are only distinguishable here.
 *
 *  Two ways to get a null level, and they are NOT the same fact. 'none' means the CLI has no
 *  effort knob at all (gemini, amp, antigravity). 'dropped' means a level WAS configured and
 *  this adapter does not have it, so nothing reached the CLI and it used its own internal
 *  default — a live hazard here, since the scales genuinely differ (muse rejects `max`,
 *  ollama's scale is not zai's), and today that failure is silent. Both stay distinguishable
 *  from a NULL column, which means "not recorded at all".
 *  Keep in sync with the `effort` jsonb on cli_invocations (@haive/database). */
export interface EffortDecision {
  level: string | null;
  source: 'step' | 'provider' | 'scale_max' | 'dropped' | 'none';
}

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
  /** When true, a steering-capable adapter builds its steerable form instead of the one-shot
   *  one: for the claude family and amp an interactive stream-json INPUT invocation (prompt on
   *  stdin), for codex a `codex app-server` JSON-RPC invocation. Set by the dispatcher only when
   *  steering is enabled AND the adapter supportsSteering AND its steering transport is ready for
   *  the provider (steeringTransportReady). Other adapters ignore it. */
  steeringMode?: boolean;
  /** Claude-family only: tool names passed to `--disallowedTools` (a deny-list;
   *  deny beats allow and is honored even under --dangerously-skip-permissions).
   *  Set for onboarding mining invocations to `['Agent']` so a mining agent cannot
   *  spawn its own Claude Code sub-agents (uncontrolled token fan-out). Non-claude
   *  adapters ignore it. */
  disallowedTools?: string[];
  /** Claude-family only: when true, emit `--tools ""` to disable ALL built-in
   *  tools so the model answers from the prompt alone (no repo crawl). Set for
   *  enrichment/classification steps whose full input is already in the prompt
   *  (e.g. 01-env-detect), where a high-effort model would otherwise burn the
   *  timeout exploring the repo. codex/gemini adapters ignore it. */
  disableTools?: boolean;
}

/** Per-task facts a steering transport can depend on — see
 *  BaseCliAdapter.steeringTransportReady. */
export interface SteeringTransportContext {
  /** The task's codex app-server verdicts, or null when the admin switch is off. */
  codexAppServer: CodexAppServerVerdicts | null;
}

export interface EffortScale {
  /** Allowed level identifiers for this CLI, ordered low-to-high. */
  values: readonly string[];
  /** Identifier corresponding to the highest effort. Used as the default
   *  when no per-provider override is set. */
  max: string;
}

/** How step 07 surfaces the merged rules block (which lives in AGENTS.md) to this CLI:
 *   - 'native': CLI auto-reads AGENTS.md.
 *   - 'import': CLI reads its own file, which holds only an `@AGENTS.md` line.
 *   - 'copy': CLI reads its own file and has no import syntax, so the file carries
 *     AGENTS.md's project-info and rules blocks itself. */
export type CliRulesFileMode = 'native' | 'import' | 'copy';

/** How exec-core / the sequential sub-agent runner should interpret the CLI's
 *  stdout. Undefined = legacy heuristic (claude NDJSON collector probe). */
export type CliOutputFormat =
  | 'plain'
  | 'claude-stream-json'
  | 'codex-jsonl'
  | 'codex-app-server'
  | 'antigravity-stream-json'
  | 'gemini-json';

export interface CliCommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  outputFormat?: CliOutputFormat;
  /** Steerable invocation: the spawner opens an interactive stdin pipe and exec-core wires a
   *  Redis steer channel into it. The claude family and amp write `stdinInitial` and take each
   *  steer as an NDJSON line; codex's app-server speaks JSON-RPC on the same pipe instead. Set by
   *  adapters in steering mode. */
  steerable?: boolean;
  /** Written to the CLI's stdin immediately after start (the prompt as an NDJSON
   *  user-message). Only present when steerable. */
  stdinInitial?: string;
  /** amp only: emit `"steer": true` on every MID-RUN stdin user-message. amp reads it as
   *  "queue this and apply it at the next interruption point"; the claude binary has no such
   *  field and must not see it. Never set on `stdinInitial` — there is no turn in progress to
   *  interrupt. Meaningful only alongside `steerable`. */
  steerFlag?: boolean;
  /** The prompt, delivered over stdin because it is too large to pass as an
   *  argument (see prompt-delivery.ts). The runner writes it and then CLOSES
   *  stdin — that close is the difference from `stdinInitial`, which stays open
   *  for the life of a steerable run. Mutually exclusive with it: a stream held
   *  open for steering never signals end-of-prompt, and the CLI would wait for
   *  input that is never coming and die on the timeout. */
  stdinPrompt?: string;
  /** Written into the sandbox before the run, for a CLI whose prompt arrives by
   *  PATH rather than argv or stdin. */
  promptFile?: { containerPath: string; content: string };
  /** This invocation is agent-ISOLATED: exec masks every repo-level agent directory with an empty
   *  read-only tmpfs, and the prompt carries the personas it needs inline instead of pointing at
   *  files that will not be there. Decided once at dispatch by `agentIsolationApplies` and carried
   *  here so the prompt and the mounts cannot disagree when the switch flips between dispatch and
   *  exec — the spec is never persisted, so a BullMQ retry replays this same decision. */
  maskAgentDefinitions?: boolean;
  /** Repository-relative paths of the persona bodies the rewrite PASTED into this prompt, for the
   *  exec-time secret-mask recheck: a deny rule or the masking switch can change while the job
   *  waits in the queue, and a body already in a prompt cannot be retracted. Recorded whether or
   *  not the invocation is isolated, because exec rechecks whatever paths are recorded. */
  pastedPersonaPaths?: string[];
  /** CLI configuration the adapter needs in place for this run, mounted read-only at a path
   *  OUTSIDE the auth volume, so nothing is merged into a config file the CLI also writes
   *  (grok: `/etc/grok/managed_config.toml`). */
  configFiles?: Array<{ containerPath: string; content: string }>;
  /** Repository directories this CLI reads from a fixed path under its home rather than from the
   *  workspace, given to it READ-ONLY from the invocation's own tree (the worktree when there is
   *  one) and only when the directory exists there. `layout: 'agentMdDirs'` re-lays flat
   *  `<id>.md` agents as `<containerDir>/<id>/agent.md` with only `name` and `description` left in
   *  the frontmatter. Volume-backed repositories only: a read-only local-path repo is bound from a
   *  host path the worker cannot see. */
  repoMirrors?: Array<{ repoDir: string; containerDir: string; layout?: 'agentMdDirs' }>;
  /** When set, the sandbox runner mounts a WRITABLE directory at
   *  `captureFile.containerDir` and, after the run, reads `<containerDir>/<fileName>`
   *  back out as `CliExecutionResult.capturedLog`. Used to recover a CLI's own log
   *  file out of the `--rm` sandbox — agy (antigravity) writes provider-fatal errors
   *  (quota/auth/5xx) ONLY to its log and exits 0 with empty output, so that log is
   *  the sole classifiable signal. Set by the antigravity adapter alongside its
   *  `--log-file` arg; no other adapter uses it. */
  captureFile?: { containerDir: string; fileName: string };
  /** codex only, set together with `outputFormat: 'codex-app-server'`. The app-server takes its
   *  turn over JSON-RPC rather than argv or stdin, so the turn's inputs travel here. `execArgs` is
   *  the `codex exec` argv for the same run, minus the prompt, kept so an invocation whose
   *  app-server could not even accept the turn can re-run on exec without calling the adapter
   *  again — see codexExecFallbackSpec. */
  codexAppServer?: {
    prompt: string;
    model: string | null;
    effort: string | null;
    execArgs: string[];
  };
  /** The persona ids Haive assigned to this run: every `[[HAIVE_AGENT_DEFINITION:<id>]]`
   *  marker the dispatch prompt carried BEFORE the rewrite, unioned with the ids a mining
   *  dispatch names explicitly (`AgentMiningDispatch.personaIds`). Read at the completion write
   *  into `tool_usage.agents.assigned`; never sent to the CLI. Absent when none. */
  assignedAgentIds?: string[];
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
  /** Same meaning as `CliCommandSpec.assignedAgentIds`: the union over every sub-agent prompt
   *  and the synthesis prompt, read before the rewrite. Absent when none. */
  assignedAgentIds?: string[];
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
