import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_SOFT_TIMEOUT_WIND_DOWN,
  CONFIG_KEYS,
  STEER_IN_CHANNEL_PREFIX,
  configService,
  type CliExecInvocationKind,
  type CliExecJobPayload,
  type CliNetworkPolicy,
  type CliProviderName,
  type CliTokenUsage,
  type ModelIdentity,
} from '@haive/shared';
import { DEFAULT_RUN_TIMEOUT_MS, type DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { NPM_CACHE_ENV, npmCacheMount, warmNpmPackage } from '../../sandbox/npm-cache.js';
import { resolveMcpSurface } from '../../sandbox/mcp-surface.js';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { cliAdapterRegistry } from '../../cli-adapters/registry.js';
import type { CliCommandSpec } from '../../cli-adapters/types.js';
import {
  createCodexJsonlCollector,
  extractGeminiJsonOutput,
  type CliExecutionResult,
  type CliSpawner,
  type SpawnOptions,
} from '../../cli-executor/index.js';
import { runInSandbox } from '../../sandbox/sandbox-runner.js';
import {
  publishCliChunk,
  publishCliSteerConsumed,
  wrapStreamCallback,
} from '../cli-stream-publisher.js';
import { log, type CliExecDeps, type ExecutionOutcome } from './_shared.js';
import { createStreamJsonCollector } from './stream.js';
import {
  buildModelIdentity,
  requestedFromSpec,
  type ModelIdentityInput,
} from './model-identity.js';
import { looksLikeJson, proseForClean } from './clean-output.js';
import { createStreamLogBuffer } from './stream-log-buffer.js';
import { createSteerForwarder, type SteerForwarder } from './steer-forwarder.js';
import { createSteerTracker } from './steer-tracker.js';
import { getRedis } from '../../redis.js';
import type { Redis } from 'ioredis';
import {
  createStepStatusUpdater,
  ensureRepoMountWritable,
  loadProviderRuntimeConfig,
  resolveAuthMounts,
  resolveMcpExtraFiles,
  resolveInvocationRepoMount,
  tryJsonParse,
  WORKER_REPO_STORAGE_ROOT,
} from './resolvers.js';
import { executeSubAgentNative, executeSubAgentSequential } from './sub-agent.js';
import { resolveSecretMasks } from './secret-mask.js';
import { worktreeGitfileMask } from './gitfile-mask.js';
import { consumePreemptionMark } from './preempt-mark.js';
import { resolveDdevGeneratedMasks } from './ddev-generated-mask.js';
import { makeUsageSnapshotPersister } from './running-usage.js';
import {
  classifyAntigravityDiagnostic,
  classifyModelCapability,
  classifyProviderFatal,
  CLI_PREEMPTED_HEADLINE,
  CLI_TIMEOUT_HEADLINE,
  isCliPreemptionFailure,
  isCliTimeoutFailure,
  MODEL_CAPABILITY_HEADLINES,
  PROVIDER_FATAL_HEADLINES,
  type ModelCapabilityClass,
  type ProviderFatalClass,
} from './failure-class.js';

/** Throttle for persisting running token-usage snapshots during a CLI stream.
 *  ~40 writes/min/invocation at most — cheap, safe under the 7-task cap. */
const RUNNING_USAGE_INTERVAL_MS = 1500;

const PROVIDER_LOGIN_HINTS: Record<string, string> = {
  'claude-code': 'claude /login',
  codex: 'codex login',
  amp: 'amp login',
  zai: 'zai login',
};

// Providers authenticated by an API-key secret rather than an interactive CLI
// login. On auth failure the hint points at the Haive-stored secret, since
// there is no login command to run. Gemini is BYOK-only after its subscription
// login path was removed.
const PROVIDER_API_KEY_HINTS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
};

// Providers whose login happens inside Haive (interactive OAuth on the providers
// page), not via a terminal command. On auth failure, point users there.
const PROVIDER_HAIVE_LOGIN: ReadonlySet<string> = new Set(['antigravity']);

// Auth hints the three maps above cannot express, keyed by provider name.
//
// grok needs one for two compounding reasons. It supports BOTH an XAI_API_KEY
// secret and an in-Haive device login, and this builder only receives a provider
// NAME, so it cannot tell which mode the failing row used — neither the api-key
// map nor the Haive-login set is right on its own. And grok collapses "not logged
// in", "key rejected" and "account out of credits" into a single "Not signed in"
// string: measured on a real failure whose own init line reported
// `apiKeySource: "user"` (the key WAS supplied and used) yet still errored with it.
// That text carries `unauthenticated`, so classifyProviderFatal reaches 'auth'
// before RATE_LIMIT_RE can ever see it — an exhausted account is therefore
// reported as an auth problem, and without this hint the user was told to
// "re-authenticate your CLI in your terminal", which an API-key provider has no
// way to do. The wording covers every case grok conflates, because nothing in its
// output distinguishes them.
const PROVIDER_AUTH_HINT_OVERRIDES: Record<string, string> = {
  grok:
    "check this provider's credentials (the `XAI_API_KEY` secret, or sign in from the Haive " +
    'providers page) and confirm the xAI account still has credits — grok reports an exhausted ' +
    'or rejected key with the same "Not signed in" message it uses for no login',
};

// Exit codes that mean the process was terminated rather than exiting on its
// own: 130 (SIGINT), 137 (SIGKILL — task cancel and step stop-&-retry force-
// remove the container, which surfaces as 137), 143 (SIGTERM). Together with a
// null exit code (the spawn killing the client on timeout/abort) these are the
// "we stopped it" signals. A terminated run is never an auth failure, and its
// partial output — often the model mid-analysis of the repo — must not reach
// the auth heuristic below, which false-matches any codebase that discusses
// login / tokens / 401 / unauthorized.
const TERMINATION_EXIT_CODES: ReadonlySet<number> = new Set([130, 137, 143]);

export function interpretCliFailure(
  result: ExecutionOutcome,
  providerName: string | null,
): string | null {
  const existing = result.errorMessage ?? null;
  // agy (antigravity) swallows provider-fatal errors to its own log file and ALWAYS
  // exits 0 with empty output, so the exit-code gate below can't see them. Classify
  // from the captured agy diagnostic log — anchored on agy's gRPC error structure and
  // gated on EMPTY output so a transient-429-then-success run (non-empty output whose
  // log still mentions 429) is never misclassified. Above the exit-0/termination
  // returns so it also catches a hypothetical future agy that exits non-zero.
  if (
    providerName === 'antigravity' &&
    result.parsedOutput == null &&
    (result.rawOutput ?? '').trim().length === 0
  ) {
    const agy = classifyAntigravityDiagnostic(result.providerDiagnosticLog ?? null);
    if (agy) {
      return buildProviderFatalMessage(agy.class, providerName, formatAuthDetail(agy.detail));
    }
  }
  if (result.exitCode === 0) return existing;
  if (result.exitCode === null || TERMINATION_EXIT_CODES.has(result.exitCode)) {
    // A kill that already identified ITSELF keeps its headline. Both self-identified kills are
    // the same transient class as the generic sentence below, and both are distinguished from it
    // only by that headline — so collapsing either one back into the generic wording silently
    // disables the behaviour that depends on it:
    //  - a budget kill (createSandboxSpawner stamps the headline + minutes) is the only transient
    //    the step runner re-dispatches at a LARGER budget; lose it and the escalating ladder
    //    stops climbing;
    //  - a preemption is the only transient that must NOT be charged to any retry budget; lose it
    //    and every eviction counts as a worker-restart orphan, so three evictions fail a task
    //    that never failed. Observed exactly that live before this line covered it.
    if (
      isCliTimeoutFailure({ errorMessage: existing }) ||
      isCliPreemptionFailure({ errorMessage: existing })
    ) {
      return existing;
    }
    return 'CLI process was stopped before it finished (cancelled or timed out).';
  }

  // Model-capability failures (no vision, output-token ceiling) come FIRST: they are
  // the most specific classes here, and unlike the fatal ones below they are things
  // Haive itself fixes — the step runner remediates the provider and re-dispatches, so
  // letting a generic classifier claim them would suppress the recovery entirely.
  const capabilityClass = classifyModelCapability(
    result.exitCode,
    existing,
    result.providerErrorScan ?? result.rawOutput,
  );
  if (capabilityClass) {
    return buildModelCapabilityMessage(capabilityClass, formatAuthDetail(existing));
  }

  // Persistent provider failures (rate-limit/quota, bad/expired auth, 5xx outage)
  // will not recover within this run. Headline them with a stable internal prefix
  // so looping consumers (isFatalProviderFailure → DAG escalation, merge-fix retry)
  // fail the task fast instead of re-dispatching agents against a dead provider.
  const fatalClass = classifyProviderFatal(
    result.exitCode,
    existing,
    result.providerErrorScan ?? result.rawOutput,
  );
  if (!fatalClass) return existing;
  return buildProviderFatalMessage(fatalClass, providerName, formatAuthDetail(existing));
}

/** Build the headlined model-capability errorMessage. The headline is what drives the
 *  automatic remediation (capabilityClassFromMessage → step-runner re-dispatch); the hint
 *  is only ever read by a human, and only when the remediation ran out of attempts — so it
 *  names the manual lever for each class rather than restating the provider's error. */
function buildModelCapabilityMessage(cls: ModelCapabilityClass, detail: string): string {
  const hint =
    cls === 'no_image_support'
      ? 'the selected model cannot read images; Haive retried without screenshots. Pick a ' +
        'vision-capable model for this step if the work needs visual verification'
      : cls === 'output_cap_reached'
        ? "the model's reply exceeded the output-token ceiling; Haive raised the ceiling and " +
          'retried. If this keeps happening, the step is asking for more output than the ' +
          'model can emit in one turn — pick a model with a larger output limit'
        : 'the provider rejected the output-token ceiling Haive set as larger than the ' +
          'model allows; the ceiling was rolled back and will not be raised again for this model';
  return `${MODEL_CAPABILITY_HEADLINES[cls]} — ${hint}.${detail}`;
}

/** Build the headlined provider-fatal errorMessage for a class + detail. Shared by the
 *  exit-code path (interpretCliFailure) and the antigravity exit-0 diagnostic-log path.
 *  `detail` is the parenthesized excerpt already formatted by formatAuthDetail. */
function buildProviderFatalMessage(
  fatalClass: ProviderFatalClass,
  providerName: string | null,
  detail: string,
): string {
  if (fatalClass === 'auth') {
    const override = providerName ? PROVIDER_AUTH_HINT_OVERRIDES[providerName] : null;
    const apiKeyName = providerName ? PROVIDER_API_KEY_HINTS[providerName] : null;
    const loginCmd = providerName ? PROVIDER_LOGIN_HINTS[providerName] : null;
    const hint = override
      ? `${override}, then retry this step`
      : apiKeyName
        ? `check or replace the \`${apiKeyName}\` secret for this provider in Haive settings and then retry this step`
        : providerName && PROVIDER_HAIVE_LOGIN.has(providerName)
          ? `log in to ${providerName} from the Haive providers page (Test connection then Log in) and then retry this step`
          : loginCmd
            ? `run \`${loginCmd}\` in your terminal and then retry this step`
            : 're-authenticate your CLI in your terminal and then retry this step';
    return `${PROVIDER_FATAL_HEADLINES.auth} — ${hint}.${detail}`;
  }
  const hint =
    fatalClass === 'rate_limit'
      ? "the provider's usage limit or quota is exhausted; retry this task once it resets"
      : 'the provider returned a server error (service unavailable); retry this task when it recovers';
  return `${PROVIDER_FATAL_HEADLINES[fatalClass]} — ${hint}.${detail}`;
}

// Keep the auth headline readable: the full CLI output stays on the
// invocation's rawOutput / stream_log for the terminal viewer, so the message
// only needs a short excerpt, not a multi-KB stdout dump.
function formatAuthDetail(existing: string | null): string {
  const trimmed = existing?.trim();
  if (!trimmed) return '';
  const capped = trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  return ` (${capped})`;
}

/** Ollama inference (especially local, on weak hardware) can take many minutes
 *  per turn. Floor the invocation timeout for Ollama providers so a slow
 *  response isn't SIGKILLed mid-generation; non-Ollama providers keep their
 *  per-step timeout unchanged. */
async function resolveInvocationTimeoutMs(
  requested: number | undefined,
  provider: { name: CliProviderName } | null | undefined,
): Promise<number | undefined> {
  if (provider?.name !== 'ollama') return requested;
  const floor = await configService.getNumber(CONFIG_KEYS.OLLAMA_CLI_TIMEOUT_MS, 7_200_000);
  return Math.max(requested ?? 0, floor);
}

/** A read-only bind of the task's OWN uploads dir into the sandbox, at the path the
 *  attachment prompt points to (`<SANDBOX_WORKDIR>/.haive/task-uploads/<taskId>`). Uploads
 *  live at the repo root under `.haive/` (git-excluded), so the worktree-only mount hides
 *  them — bind just this task's dir back in (never sibling tasks' uploads). Volume-mounted
 *  repos only: a bind (local) repo keeps its repo-root mount so uploads are already visible,
 *  and a repo-less task has none. Returns null when the task has no attachments (matching
 *  augmentPromptWithAttachments' gate) or the dir isn't present (skip rather than fail the
 *  docker mount). */
async function resolveTaskUploadsMount(
  db: Database,
  taskId: string,
  repoMount: DockerVolumeMount | null,
): Promise<DockerVolumeMount | null> {
  if (!repoMount?.subpath) return null;
  const rows = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.taskId, taskId),
    columns: { id: true },
    limit: 1,
  });
  if (rows.length === 0) return null;
  const repoBase = repoMount.subpath.split('/').slice(0, 2).join('/');
  const uploadsSubpath = `${repoBase}/.haive/task-uploads/${taskId}`;
  const present = await stat(join(WORKER_REPO_STORAGE_ROOT, uploadsSubpath))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!present) return null;
  return {
    source: repoMount.source,
    target: `${SANDBOX_WORKDIR}/.haive/task-uploads/${taskId}`,
    subpath: uploadsSubpath,
    readOnly: true,
  };
}

export async function executeByKind(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
  secrets: Record<string, string>,
): Promise<ExecutionOutcome> {
  // Isolate this invocation to ONE git worktree: mount it ALONE at the workdir root
  // (payload.worktreeSubpath for a DAG/merge sibling, else the task's feature worktree)
  // so the agent cannot reach the repo-root checkout or any sibling worktree. The
  // worktree IS the mount root, so the container workdir is SANDBOX_WORKDIR.
  const { repoMount, hasWorktree } = await resolveInvocationRepoMount(
    db,
    payload.taskId,
    payload.worktreeRel,
  );
  await ensureRepoMountWritable(repoMount);
  const sandboxWorkdir = SANDBOX_WORKDIR;
  // Empty-file masks hiding deny-listed secret files from the agent (Tier 1,
  // untracked-only). Applied to every cli-exec kind; the app runtime mounts the
  // same repo volume WITHOUT these masks, so the running app still sees them.
  // The worktree gitfile mask rides the same mechanism but is an integrity control,
  // not a secrecy one — it is never gated by the secret-mask kill-switch. The
  // `#ddev-generated` masks are the same kind of control: they keep an agent from taking
  // over a file DDEV owns (and thereby freezing it against regeneration), which is how a
  // dropped `/phpstatus` alias made every later `ddev start` time out.
  //
  // ORDER IS PRECEDENCE. Two sources can select the same file — `.ddev/traefik/certs/
  // <project>.key` is both `#ddev-generated` and a `**/*.key` secret — and docker refuses
  // to start a container with two mounts on one target, so sandbox-runner keeps the FIRST
  // entry per path. Secret masks go first deliberately: their empty content hides the
  // bytes AND blocks writes, so it strictly dominates the ddev mask on a collision.
  const maskFiles = [
    ...(await resolveSecretMasks(db, payload.taskId, repoMount)),
    ...worktreeGitfileMask(hasWorktree),
    ...(await resolveDdevGeneratedMasks(db, payload.taskId, repoMount)),
  ];
  switch (payload.kind) {
    case 'cli':
    case 'agent_mining': {
      const { wrapperContent, sandboxImage, networkPolicy, egressDomains } =
        await loadProviderRuntimeConfig(db, payload.cliProviderId, payload.taskId);
      const providerRow = payload.cliProviderId
        ? await db.query.cliProviders.findFirst({
            where: eq(schema.cliProviders.id, payload.cliProviderId),
          })
        : null;
      let authMounts: DockerVolumeMount[] = [];
      if (providerRow && cliAdapterRegistry.has(providerRow.name)) {
        authMounts = await resolveAuthMounts(db, providerRow, payload.taskId);
      }
      // The task's own uploads dir (read-only) so the agent can read attachments the
      // prompt references — the worktree-only mount hides the repo-root .haive/ otherwise.
      const uploadsMount = await resolveTaskUploadsMount(db, payload.taskId, repoMount);
      if (uploadsMount) authMounts.push(uploadsMount);
      const mcp = providerRow
        ? await resolveMcpExtraFiles(
            db,
            payload.taskId,
            providerRow.name as CliProviderName,
            sandboxWorkdir,
            sandboxImage,
            // Narrowed only when the STEP said so (report-only steps that cannot act on
            // a browser or a container). Never inferred from `kind`: the fan-out
            // machinery is shared by knowledge mining, the review personas and the
            // adversarial-QA agents, and forcing rag-only on all three gave 08d a live
            // app URL it had no browser to reach.
            payload.toolProfile === 'rag_only',
          )
        : { files: [], extraArgs: [] };
      // Pre-warm the shared npm cache for the ONE MCP server that is fetched from npm.
      // chrome-devtools-mcp's cold fetch (MEASURED 111-146s) outran the agent's ~50s
      // wait for its tools, so 08a silently fell back to static analysis while still
      // reporting a pass. Warm is ~4s. Best-effort and never fatal — a failure just
      // restores the old fetch-on-demand behaviour.
      if (providerRow && sandboxImage) {
        const surface = await resolveMcpSurface(
          db,
          payload.taskId,
          payload.toolProfile === 'rag_only',
        );
        if (surface.chromeDevtools.enabled) {
          await warmNpmPackage(
            sandboxImage,
            `chrome-devtools-mcp@${surface.chromeDevtools.version?.trim() || 'latest'}`,
          );
        }
      }
      const statusUpdater = payload.taskStepId
        ? createStepStatusUpdater(db, payload.taskStepId, payload.invocationId)
        : undefined;
      const timeoutMs = await resolveInvocationTimeoutMs(payload.timeoutMs, providerRow);
      return executeCliSpec(
        payload.spec as CliCommandSpec,
        deps,
        timeoutMs,
        secrets,
        wrapperContent,
        sandboxImage,
        repoMount,
        sandboxWorkdir,
        networkPolicy,
        egressDomains,
        [...mcp.files, ...maskFiles],
        authMounts,
        statusUpdater,
        payload.taskId ?? null,
        payload.invocationId ?? null,
        mcp.extraArgs,
        makeUsageSnapshotPersister(db, payload.invocationId),
        payload.softTimeout === true,
      );
    }
    case 'subagent_sequential':
      return executeSubAgentSequential(db, payload, secrets, repoMount, sandboxWorkdir, maskFiles);
    case 'subagent_native':
      return executeSubAgentNative(
        db,
        payload,
        deps,
        secrets,
        repoMount,
        sandboxWorkdir,
        maskFiles,
      );
    default:
      throw new Error(
        `unknown cli exec kind: ${(payload as { kind: CliExecInvocationKind }).kind}`,
      );
  }
}

export async function executeCliSpec(
  spec: CliCommandSpec,
  deps: CliExecDeps,
  timeoutMs?: number,
  secrets: Record<string, string> = {},
  wrapperContent: string | null = null,
  sandboxImage: string | null = null,
  repoMount: DockerVolumeMount | null = null,
  sandboxWorkdir: string = SANDBOX_WORKDIR,
  networkPolicy: CliNetworkPolicy | null = null,
  egressDomains: string[] = [],
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
  statusCallback?: (message: string) => void,
  taskId: string | null = null,
  invocationId: string | null = null,
  mcpExtraArgs: string[] = [],
  onUsageSnapshot?: (usage: CliTokenUsage | null) => void,
  softTimeout = false,
): Promise<ExecutionOutcome> {
  const mergedSpec: CliCommandSpec = {
    ...spec,
    args: mcpExtraArgs.length > 0 ? [...spec.args, ...mcpExtraArgs] : spec.args,
    env: { ...spec.env, ...secrets },
  };
  // Ollama's key is intuitively named OLLAMA_API_KEY, but the claude binary
  // authenticates with ANTHROPIC_AUTH_TOKEN. A key stored as a secret merges in
  // above (post-build, so the adapter couldn't see it); map it onto the token
  // here unless an explicit Anthropic token was set (the adapter's 'ollama'
  // placeholder counts as unset). Harmless for non-Ollama providers.
  if (
    mergedSpec.env.OLLAMA_API_KEY &&
    (!mergedSpec.env.ANTHROPIC_AUTH_TOKEN || mergedSpec.env.ANTHROPIC_AUTH_TOKEN === 'ollama')
  ) {
    mergedSpec.env.ANTHROPIC_AUTH_TOKEN = mergedSpec.env.OLLAMA_API_KEY;
    mergedSpec.env.ANTHROPIC_API_KEY = mergedSpec.env.OLLAMA_API_KEY;
  }
  // Global opt-in: when prompt-caching-1h is ON, ask the claude binary to use the
  // 1-hour cache TTL (default 5-min on API-key/Bedrock; subscription is already 1h).
  // Gated on the claude-family stream-json output so codex/gemini are untouched;
  // harmless on non-Anthropic claude-family backends (zai/ollama ignore the flag).
  if (
    mergedSpec.outputFormat === 'claude-stream-json' &&
    (await configService.getBoolean(CONFIG_KEYS.PROMPT_CACHING_1H, false))
  ) {
    mergedSpec.env.ENABLE_PROMPT_CACHING_1H = '1';
  }
  const spawner: CliSpawner = createSandboxSpawner(
    wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    networkPolicy,
    egressDomains,
    extraFiles,
    authMounts,
    taskId,
    invocationId,
  );

  // Capture exactly what the live WS viewer sees (header + every stdout/
  // stderr chunk) into a buffer so we can persist it to cli_invocations.
  // stream_log for historical replay. The spawner's wrapStreamCallback
  // publishes to Redis AND invokes our tees here, so the buffer matches
  // the bytes the user saw.
  // Bounded: a single codex `exec --json` run can inline tens of MB of MCP tool
  // results here. The collectors and the live Redis publish are fed separately, so
  // the bound only trims the persisted replay. See stream-log-buffer.ts.
  const streamBuf = createStreamLogBuffer();
  const headerText = formatCliHeader(mergedSpec, sandboxWorkdir);
  if (invocationId) {
    await publishCliChunk(invocationId, 'stdout', headerText);
  }
  streamBuf.push(headerText);

  // Hook stdout for structured-output parsing. Codex's JSONL events carry
  // string `type` fields that would satisfy the claude collector's event
  // heuristic while never producing a result event — so the codex collector
  // REPLACES the claude collector (mutually exclusive), it does not run
  // alongside it.
  const outputFormat = mergedSpec.outputFormat;
  // Publish the model's prose text (assistant text blocks / codex agent_message)
  // as a dedicated `text` frame so the terminal viewer's Clean tab can render
  // readable output instead of the raw NDJSON. Live runs only (needs an
  // invocation stream); replay reuses the persisted rawOutput.
  const onProseText = invocationId
    ? (text: string) => {
        void publishCliChunk(invocationId, 'text', text);
      }
    : undefined;
  // Mid-run steering: for a steerable invocation, subscribe a dedicated Redis
  // connection to this invocation's steer channel and forward each message to
  // the CLI's stdin. The collector's onResult latches the forwarder closed (end
  // stdin so the CLI exits after its turn). See steer-forwarder.ts.
  const steerable = mergedSpec.steerable === true && !!invocationId;
  let steer: SteerForwarder | null = null;
  // Drains the tracker at each tool-call boundary and publishes a consumed frame
  // per steer. Defined only for a steerable invocation; passed to the collector.
  let onSteerBoundary: (() => void) | undefined;
  if (steerable && invocationId) {
    const channel = `${STEER_IN_CHANNEL_PREFIX}${invocationId}`;
    // A subscriber connection is mode-locked — duplicate the shared client
    // rather than reuse it (Hole E). Subscribe BEFORE the spawner starts so an
    // instantly-published steer isn't missed.
    const sub: Redis = getRedis().duplicate();
    // The forwarder records each written steer; the boundary callback (fed to
    // the collector below) reports them consumed when Claude drains the queue.
    const tracker = createSteerTracker();
    steer = createSteerForwarder({
      subscriber: sub,
      onWritten: (s) => tracker.recordWritten(s),
    });
    onSteerBoundary = () => {
      for (const s of tracker.drainConsumed()) {
        void publishCliSteerConsumed(invocationId, s.id);
      }
    };
    await sub.subscribe(channel);
  }
  // Soft timeout: the hard one is a zero-grace SIGKILL, so a reviewer that runs its full
  // budget loses every finding it made. Well before that, ask it to bank the verified
  // ones. Opt-in per invocation, because for a step that WRITES (code, files, skills) an
  // early "emit now" turns a loud timeout into a silent partial success — strictly worse
  // than the kill. Published to the SAME steer channel rather than written straight to
  // the captured stdin: that reuses the forwarder's sawResult latch, its
  // writable.writable guard and its EPIPE swallow. It also stays out of the api's steer
  // route, which would write a `steering.nudge` task_event — _task-history-digest reads
  // those as a human-friction signal, and an automated wind-down is not friction.
  const softTimeoutTimer =
    steerable && invocationId && softTimeout
      ? await scheduleSoftTimeout(invocationId, timeoutMs)
      : null;
  // The wind-down travels as a steer, so it only exists for a steerable CLI — today
  // claude-code, muse, zai, ollama and openrouter. On codex/gemini/amp/antigravity a step that asked
  // for softTimeout silently gets none: the run is SIGKILLed at its budget with zero grace
  // and every unbanked finding dies with it. That is exactly how 08c lost three reviewers
  // in one round on codex while its own comment promised they would be asked to bank first.
  // Log it, because the step's mitigation is not merely weaker here — it is absent.
  if (softTimeout && invocationId && !steerable) {
    log.warn(
      { invocationId, timeoutMs },
      'soft timeout requested but this provider is not steerable — the run will be SIGKILLed with no wind-down',
    );
  }

  const collector = createStreamJsonCollector(
    statusCallback,
    onProseText,
    steer ? steer.onResult : undefined,
    onSteerBoundary,
  );
  const codexCollector =
    outputFormat === 'codex-jsonl' ? createCodexJsonlCollector(onProseText) : null;

  // While the CLI streams, persist a running token-usage snapshot on a throttle
  // so the task page + terminal polls show a live, growing count before the
  // invocation completes. getTokenUsage() returns the running total mid-stream;
  // we skip when it hasn't changed. Cleared before returning (incl. on throw);
  // the final authoritative tokenUsage is written on completion (handlers.ts).
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  if (onUsageSnapshot) {
    let lastUsageJson = '';
    usageTimer = setInterval(() => {
      const usage = (codexCollector ?? collector).getTokenUsage();
      if (!usage) return;
      const json = JSON.stringify(usage);
      if (json === lastUsageJson) return;
      lastUsageJson = json;
      onUsageSnapshot(usage);
    }, RUNNING_USAGE_INTERVAL_MS);
  }

  let result: CliExecutionResult;
  try {
    result = await spawner(mergedSpec, {
      timeoutMs,
      onStdoutChunk: (chunk: string) => {
        streamBuf.push(chunk);
        if (codexCollector) codexCollector.onChunk(chunk);
        else collector.onChunk(chunk);
      },
      onStderrChunk: (chunk: string) => {
        streamBuf.push(chunk);
      },
      onStdinWritable: steer ? steer.captureWritable : undefined,
    });
  } finally {
    if (usageTimer) clearInterval(usageTimer);
    if (softTimeoutTimer) clearTimeout(softTimeoutTimer);
    if (steer) steer.teardown();
  }
  const streamLog = streamBuf.toString();
  // Raw CLI stdout+stderr tail for provider-fatal classification. rawOutput is
  // now sanitized for the Clean tab (prose or empty), so it can no longer carry
  // an API error the classifier needs. Excludes the header/prompt (which
  // streamLog includes) so a task spec mentioning "rate limit"/"401" cannot
  // false-positive. See interpretCliFailure / classifyProviderFatal.
  const providerErrorScan = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-4000);
  void deps;

  // Which model actually answered. Built from whichever channel this CLI speaks and
  // attached to every return branch beside tokenUsage — same parse of the same
  // output, so nothing extra is spawned, prompted or billed to collect it. The
  // spec-derived value is the fallback for CLIs whose output names no model at all
  // (codex names it only in its own argv; amp not at all).
  const specRequestedModel = requestedFromSpec(mergedSpec);
  const modelIdentityFrom = (
    extra: Omit<ModelIdentityInput, 'specRequested'> = {},
  ): ModelIdentity | null => buildModelIdentity({ specRequested: specRequestedModel, ...extra });

  if (codexCollector && codexCollector.isJsonl()) {
    const codexText = codexCollector.getResult();
    const tokenUsage = codexCollector.getTokenUsage();
    if (codexText !== null) {
      // rawOutput = the model's answer text — the step parsers' fenced-JSON
      // contract (parsedOutput ?? rawOutput) is preserved.
      return {
        exitCode: result.exitCode,
        rawOutput: codexText,
        parsedOutput: tryJsonParse(codexText),
        errorMessage: formatCliErrorMessage(
          result.exitCode,
          result.stderr,
          codexText,
          result.error,
        ),
        tokenUsage,
        // codex names no model on any typed event (verified against a complete
        // successful run), so this carries the argv value only, with served null.
        modelIdentity: modelIdentityFrom(),
        streamLog,
      };
    }
    // JSONL stream without an agent message — partial usage is still recorded.
    // No prose to recover; keep the raw codex JSONL out of the Clean tab.
    return {
      exitCode: result.exitCode,
      rawOutput: proseForClean('', result.stdout),
      parsedOutput: null,
      errorMessage:
        result.error ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        codexCollector.getNoResultReason() ??
        'codex emitted no agent message',
      tokenUsage,
      modelIdentity: modelIdentityFrom(),
      streamLog,
      providerErrorScan,
    };
  }
  // codexCollector with zero events: old binary ignored --json — fall through
  // to the plain path below, byte-for-byte legacy behavior (usage null).

  const streamResult = collector.getResult();
  if (collector.isStreamJson() && streamResult !== null) {
    const malformedLines = collector.getMalformedLineCount();
    const assistantText = collector.getAssistantText();
    // Cross-check: does the result event's payload match the concatenation of
    // assistant text deltas? Divergence implies claude-code's result-event
    // synthesis is dropping/duplicating content (a binary bug). Identical
    // payloads mean the model itself produced what we got.
    if (assistantText.length > 0 && assistantText !== streamResult) {
      const sameLength = streamResult.length === assistantText.length;
      let firstDivergeIdx = -1;
      const minLen = Math.min(streamResult.length, assistantText.length);
      for (let i = 0; i < minLen; i++) {
        if (streamResult[i] !== assistantText[i]) {
          firstDivergeIdx = i;
          break;
        }
      }
      if (firstDivergeIdx === -1) firstDivergeIdx = minLen;
      log.warn(
        {
          command: spec.command,
          resultLen: streamResult.length,
          assistantTextLen: assistantText.length,
          sameLength,
          firstDivergeIdx,
          malformedLines,
          resultSnippet: streamResult.slice(
            Math.max(0, firstDivergeIdx - 40),
            firstDivergeIdx + 40,
          ),
          assistantSnippet: assistantText.slice(
            Math.max(0, firstDivergeIdx - 40),
            firstDivergeIdx + 40,
          ),
        },
        'stream-json result event diverges from concatenated assistant deltas',
      );
    } else if (malformedLines > 0) {
      log.warn({ command: spec.command, malformedLines }, 'stream-json had malformed lines');
    }
    return {
      exitCode: result.exitCode,
      rawOutput: streamResult,
      parsedOutput: tryJsonParse(streamResult),
      errorMessage: formatCliErrorMessage(
        result.exitCode,
        result.stderr,
        streamResult,
        result.error,
      ),
      tokenUsage: collector.getTokenUsage(),
      modelIdentity: modelIdentityFrom({ stream: collector.getModelIdentity() }),
      streamLog,
    };
  }

  if (collector.isStreamJson() && streamResult === null) {
    const reason = collector.getNoResultReason() ?? 'LLM emitted no result event';
    // No `result` event (run killed/timed-out/aborted, e.g. exit 137). Store the
    // assistant prose that DID stream — NOT result.stdout, which is the full raw
    // NDJSON: it becomes the Clean tab's replay source (raw_output ->
    // staticCleanOutput) and would render as raw protocol, ballooning Clean to MBs.
    // The full raw stream stays in streamLog (the Raw tab). Falls back to
    // result.stdout only when no prose streamed at all — preserving prior behavior
    // and the provider-fatal rawOutput tail scan for that case.
    const partialProse = proseForClean(collector.getAssistantText(), result.stdout);
    // A run-level `is_error` result carries the binary's own error text ("API Error:
    // The response stopped arriving."), which is strictly better than what
    // formatCliErrorMessage would produce here: with stderr empty it falls back to
    // the stdout tail, and for a stream-json CLI that is 2000 chars of raw NDJSON.
    // Still below result.error, so a Haive-inflicted kill keeps its headline (the
    // timeout ladder reads it).
    const apiErrorReason = collector.hadResultError() ? reason : null;
    return {
      exitCode: result.exitCode,
      rawOutput: partialProse,
      parsedOutput: null,
      errorMessage:
        result.error ??
        apiErrorReason ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        reason,
      // Tokens were burned even without a result event (e.g. error_max_turns).
      tokenUsage: collector.getTokenUsage(),
      // Worth keeping on a failed run: the init event still names what was asked
      // for, which is how a task that died on "unrecognized model" shows which
      // model it tried. served stays null unless a turn came back before the fault.
      modelIdentity: modelIdentityFrom({ stream: collector.getModelIdentity() }),
      streamLog,
      providerErrorScan,
    };
  }

  if (outputFormat === 'gemini-json') {
    // Gemini JSON mode wraps the answer: {response, stats}. Unwrap so the
    // step parsers see the model's text; extraction failure (older binary,
    // ignored flag, crash output) falls through to the legacy plain return.
    const extracted = extractGeminiJsonOutput(result.stdout);
    if (extracted) {
      return {
        exitCode: result.exitCode,
        rawOutput: extracted.responseText,
        parsedOutput: tryJsonParse(extracted.responseText),
        errorMessage: formatCliErrorMessage(
          result.exitCode,
          result.stderr,
          extracted.responseText,
          result.error,
        ),
        tokenUsage: extracted.tokenUsage,
        // gemini names its models only as the keys of stats.models.
        modelIdentity: modelIdentityFrom({ geminiModels: extracted.models }),
        streamLog,
      };
    }
    // Extraction failed. A JSON envelope here (the wrapper we could not unwrap,
    // or crash output) must not reach Clean — empty raw_output instead of raw
    // JSON. Plain text (an older binary that ignored --output-format json) is
    // genuine prose and falls through to the plain return below.
    if (looksLikeJson(result.stdout)) {
      return {
        exitCode: result.exitCode,
        rawOutput: '',
        parsedOutput: null,
        errorMessage: formatCliErrorMessage(
          result.exitCode,
          result.stderr,
          result.stdout,
          result.error,
        ),
        tokenUsage: null,
        modelIdentity: modelIdentityFrom(),
        streamLog,
        providerErrorScan,
      };
    }
  }

  // Plain/last-resort path (no structured format, or a collector that saw zero
  // events). Keep stdout as prose unless it is actually machine protocol. antigravity
  // lands here (no outputFormat); its captured agy log rides providerDiagnosticLog for
  // the exit-0 fatal classification in interpretCliFailure.
  return {
    exitCode: result.exitCode,
    rawOutput: proseForClean('', result.stdout),
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: formatCliErrorMessage(
      result.exitCode,
      result.stderr,
      result.stdout,
      result.error,
    ),
    tokenUsage: collector.getTokenUsage(),
    // antigravity lands here. Its captured --log-file is the only place it names a
    // model, and then only as a human label ("Gemini 3.7 Flash (High)").
    modelIdentity: modelIdentityFrom({
      stream: collector.getModelIdentity(),
      antigravityLog: result.capturedLog ?? null,
    }),
    streamLog,
    providerErrorScan,
    providerDiagnosticLog: result.capturedLog ?? undefined,
  };
}

/**
 * Build a user-facing error message for a CLI invocation.
 *
 * Surfaces content in priority order: spawn error (timeout, crash) → stderr tail
 * → stdout tail. Stdout fallback catches cases where CLIs like Claude Code or
 * Z.AI emit the API error on stdout (e.g. "API Error: {...code:500}") and exit
 * non-zero with empty stderr.
 */
export function formatCliErrorMessage(
  exitCode: number | null,
  stderr: string,
  stdout: string,
  spawnError: string | undefined,
): string | null {
  if (spawnError) return spawnError;
  if (exitCode === 0) return null;
  const stderrTail = stripBenignCliNoise(stderr);
  if (stderrTail.length > 0) return stderrTail.slice(-2000);
  const stdoutTail = stripBenignCliNoise(stdout);
  if (stdoutTail.length > 0) return stdoutTail.slice(-2000);
  return `cli exited with code ${exitCode ?? 'unknown'}`;
}

// CLIs print benign advisories that are NOT failure causes but were becoming the
// surfaced error (each was the stderr/stdout tail and masked the real message):
//  - claude-code, when its `.claude.json` seed is absent ("Claude configuration
//    file not found … A backup file exists … restore by running: cp …"); it then
//    continues with a fallback.
//  - codex, "Reading additional input from stdin..." — printed while it keeps
//    stdin open for steering; the real error (e.g. "You've hit your usage limit")
//    lands on the other stream / later in the same one.
// Strip these lines so the genuine error — or the stdout fallback — surfaces. The
// full text stays in rawOutput/streamLog. The advisory strings are volatile
// upstream wording: if reworded we simply stop stripping (show it), never crash.
const BENIGN_CLI_NOISE_LINE =
  /^(Claude configuration file not found at:|A backup file exists at:|You can manually restore it by running:|Reading additional input from stdin)/;

// The claude binary also logs STRUCTURED diagnostics to stderr for its own internal
// side queries — conversation titling, and similar background calls:
//
//   [claude-code:unrecognized_model] {"model":"…","query_source":"generate_session_title"}
//
// These are NOT the run's outcome. The binary emits them and carries on: the line
// above appears BEFORE the session `init` event, and the session then starts fine.
// But stderr outranks stdout in formatCliErrorMessage, so one of these would become
// the surfaced error and bury the real failure sitting in the stream-json result —
// observed exactly that on an OpenRouter task, where the step reported
// `unrecognized_model … generate_session_title` while the actual cause was a 400 on
// the main request. The wrong sentence sent the diagnosis in the wrong direction.
//
// Keyed on the STRUCTURE, not the wording: a bracketed `[tag:class]` prefix followed
// by a JSON object carrying `query_source`, which is what marks the line as being
// about an internal sub-query rather than the invocation. If the binary reworks this
// format we simply stop stripping (the line shows again) — never a crash, and the
// full text always remains in rawOutput/streamLog either way.
const CLI_SIDE_QUERY_DIAGNOSTIC_LINE = /^\[[a-z0-9-]+:[a-z0-9_]+\]\s*\{.*"query_source"\s*:/i;

function stripBenignCliNoise(text: string): string {
  return text
    .split('\n')
    .filter(
      (line) =>
        !BENIGN_CLI_NOISE_LINE.test(line.trim()) &&
        !CLI_SIDE_QUERY_DIAGNOSTIC_LINE.test(line.trim()),
    )
    .join('\n')
    .trim();
}

export function quoteArg(arg: string): string {
  // Pretty-print quoting for the terminal viewer. Output stays a valid
  // shell-quoted token (copy-paste works) but prefers whichever quote style
  // keeps the body readable:
  //   - no special chars     -> bare
  //   - has `'` only         -> double-quoted (apostrophe doesn't need escape)
  //   - everything else      -> single-quoted (no inner escaping needed at all)
  // The previous version always used POSIX `'\''` close-reopen escapes which
  // are technically correct but visually noisy when the prompt body has
  // English contractions ("don't", "it's").
  if (arg === '' || /[\s"'`$\\!<>|&;()[\]*?#~]/.test(arg)) {
    if (arg.includes("'") && !/[`$\\]/.test(arg)) {
      // Safe to use double quotes: only `"`, `\`, `$`, backtick require
      // escaping inside `"..."`, and we just confirmed none of `$ \\ \``
      // appear. Escape any literal `"` so the wrapping quotes stay matched.
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    // Single-quoted form. If the arg ALSO contains `'`, fall back to the
    // POSIX close-escape-reopen idiom — uglier but still copy-pasteable.
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  return arg;
}

export function formatCliHeader(spec: CliCommandSpec, workdir: string): string {
  // Echo the full untruncated invocation. Long prompts (a couple of KB
  // including system-prompt payloads) wrap in xterm but stay in scrollback,
  // which is the observability win — being able to copy-paste the exact
  // command is more valuable than keeping the header to a single line.
  const parts = [spec.command, ...spec.args.map(quoteArg)];
  const cmdLine = parts.join(' ');
  // ANSI: dim grey for metadata, cyan `$` prompt, default for the command.
  // \r\n keeps xterm aligned across line endings.
  let header = `\x1b[2m# workdir: ${workdir}\x1b[0m\r\n` + `\x1b[36m$\x1b[0m ${cmdLine}\r\n`;
  // Steering mode feeds the prompt on stdin (NDJSON), so the command line above
  // omits it — surface it on its own line so the viewer still shows what was
  // asked.
  if (spec.stdinInitial) {
    const promptText = extractStdinPromptText(spec.stdinInitial);
    if (promptText) header += `\x1b[2m# stdin prompt: ${promptText}\x1b[0m\r\n`;
  }
  return header;
}

/** Pull the human prompt text out of a steering stdinInitial NDJSON line for the
 *  terminal header. Returns '' if it isn't the expected user-message shape. */
function extractStdinPromptText(stdinInitial: string): string {
  try {
    const obj = JSON.parse(stdinInitial.trim()) as {
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    const blocks = obj.message?.content ?? [];
    return blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  } catch {
    return '';
  }
}

/** Delay before the wind-down fires, or null when it must not fire at all.
 *
 *  Null at percent <= 0 (the wind-down would land before the CLI has read anything)
 *  and at percent >= 100 (it would land after the SIGKILL). A non-integer or NaN
 *  percent cannot reach here: configService.getNumber parses with parseInt and falls
 *  back to the default. A zero or negative budget has no room for a wind-down. */
export function softTimeoutDelayMs(timeoutMs: number, percent: number): number | null {
  if (percent <= 0 || percent >= 100 || timeoutMs <= 0) return null;
  const delay = Math.floor((timeoutMs * percent) / 100);
  return delay > 0 ? delay : null;
}

/** Arm the wind-down for a steerable invocation. Returns the timer so the caller can
 *  clear it once the CLI exits, or null when the soft timeout is off / mistuned.
 *  Best-effort: a config or publish failure must never fail the invocation. */
async function scheduleSoftTimeout(
  invocationId: string,
  timeoutMs: number | undefined,
): Promise<ReturnType<typeof setTimeout> | null> {
  let enabled: boolean;
  let percent: number;
  try {
    enabled = await configService.getBoolean(CONFIG_KEYS.CLI_SOFT_TIMEOUT_ENABLED, true);
    percent = await configService.getNumber(CONFIG_KEYS.CLI_SOFT_TIMEOUT_PERCENT, 80);
  } catch {
    return null;
  }
  if (!enabled) return null;
  // An invocation that named no timeout still gets one: the runner's default, which it
  // will SIGKILL on. Wind down against that, not against a step's absent number.
  const budgetMs = timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const delayMs = softTimeoutDelayMs(budgetMs, percent);
  if (delayMs === null) {
    log.warn({ invocationId, percent, budgetMs }, 'soft timeout skipped: percent out of range');
    return null;
  }
  return setTimeout(() => {
    // Whole body guarded: getRedis() THROWS when redis is uninitialized, and it throws
    // synchronously, before .publish() can attach a .catch(). An uncaught throw inside
    // a timer callback takes down the worker process, and a missed wind-down is a lost
    // review, not a lost worker.
    try {
      // id '' marks it as not a user steer. publishCliSteerConsumed drops an empty
      // steerId, so the wind-down never ticks a row in the user's steer list.
      const payload = JSON.stringify({ id: '', text: CLI_SOFT_TIMEOUT_WIND_DOWN });
      void getRedis()
        .publish(`${STEER_IN_CHANNEL_PREFIX}${invocationId}`, payload)
        .then(() => log.info({ invocationId, delayMs, percent }, 'soft timeout: wind-down sent'))
        .catch((err: unknown) => log.warn({ err, invocationId }, 'soft timeout publish failed'));
    } catch (err) {
      log.warn({ err, invocationId }, 'soft timeout publish failed');
    }
  }, delayMs);
}

export function createSandboxSpawner(
  wrapperContent: string | null | undefined,
  sandboxImage: string | null = null,
  repoMount: DockerVolumeMount | null = null,
  sandboxWorkdir: string = SANDBOX_WORKDIR,
  networkPolicy: CliNetworkPolicy | null = null,
  egressDomains: string[] = [],
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
  taskId: string | null = null,
  invocationId: string | null = null,
  mcpExtraArgs: string[] = [],
): CliSpawner {
  return async (spec, opts: SpawnOptions = {}): Promise<CliExecutionResult> => {
    const allMounts: DockerVolumeMount[] = [...authMounts];
    if (repoMount) allMounts.push(repoMount);
    // Shared npm cache: the sandbox is --rm, so without this every `npx`-launched MCP
    // server re-downloads on every invocation. See sandbox/npm-cache.ts for what that
    // silently cost browser verification.
    allMounts.push(npmCacheMount());
    const runnerOptions: Parameters<typeof runInSandbox>[1] = { workdir: sandboxWorkdir };
    if (sandboxImage) runnerOptions.image = sandboxImage;
    if (allMounts.length > 0) runnerOptions.extraMounts = allMounts;
    if (networkPolicy) runnerOptions.networkPolicy = networkPolicy;
    if (egressDomains.length > 0) runnerOptions.egressDomains = egressDomains;
    if (taskId) runnerOptions.taskId = taskId;
    // Lets the preemption sweeper kill exactly this run instead of the task's whole fan-out.
    if (invocationId) runnerOptions.invocationId = invocationId;
    const finalArgs = mcpExtraArgs.length > 0 ? [...spec.args, ...mcpExtraArgs] : spec.args;
    const result = await runInSandbox(
      {
        command: spec.command,
        args: finalArgs,
        env: { ...NPM_CACHE_ENV, ...spec.env },
        wrapperContent: wrapperContent ?? undefined,
        extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
        timeoutMs: opts.timeoutMs,
        onStdoutChunk: wrapStreamCallback(invocationId, 'stdout', opts.onStdoutChunk),
        onStderrChunk: wrapStreamCallback(invocationId, 'stderr', opts.onStderrChunk),
        signal: opts.signal,
        interactive: spec.steerable === true,
        stdinInitial: spec.stdinInitial,
        onStdinWritable: opts.onStdinWritable,
        // Set only by the antigravity adapter — recover agy's own log file (where it
        // reports provider-fatal errors while exiting 0) out of the --rm sandbox.
        captureDir: spec.captureFile,
      },
      runnerOptions,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      // A budget SIGKILL leaves exitCode null / 137 and NO spawn error, which reads
      // downstream exactly like a cancel or a worker-restart orphan — yet only this case
      // must come back with a bigger budget. Stamp the headline here, the one place where
      // "we killed it because time ran out" is authoritative and the budget is in scope;
      // formatCliErrorMessage prefers a spawn error, so it reaches every return site of
      // executeCliSpec without touching any of them. A real spawn error still wins: it
      // says why the process never ran, which outranks how long we waited.
      // A preemption kill lands here identically to a budget kill (137/null, no spawn error), so
      // it is stamped the same way and for the same reason — this is the one place that knows WHY
      // the process died. Ordered AFTER timedOut deliberately: if the run's own timer fired, the
      // timeout is the real cause and must win, or a preemption racing a genuine timeout would
      // hide it and the escalating budget ladder would never climb.
      error:
        result.error ??
        (result.timedOut
          ? `${CLI_TIMEOUT_HEADLINE} (${Math.round((opts.timeoutMs ?? 0) / 60_000)}m).`
          : invocationId && (await consumePreemptionMark(invocationId))
            ? `${CLI_PREEMPTED_HEADLINE}. The step re-runs automatically; nothing is lost but this round's work.`
            : undefined),
      capturedLog: result.capturedLog,
    };
  };
}
