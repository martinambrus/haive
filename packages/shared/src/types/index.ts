export type WorkflowType = 'onboarding' | 'workflow' | 'onboarding_upgrade' | 'run_app';

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_pr'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  'pending' | 'running' | 'waiting_form' | 'waiting_cli' | 'done' | 'failed' | 'skipped';

export type CliProviderName =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'amp'
  | 'zai'
  | 'antigravity'
  | 'ollama'
  | 'muse'
  | 'grok'
  | 'openrouter';

export type AuthMode = 'subscription' | 'api_key';

/**
 * Structured hint attached to a failed task_step so the UI can render
 * actionable recovery affordances (e.g. a "Log in to CLI" button) instead of
 * a plain text error. Discriminated on `type` — new kinds can be added without
 * breaking existing consumers.
 */
export type StepErrorHint =
  | {
      type: 'cli_login_required';
      providerId: string;
      providerName: CliProviderName;
    }
  | {
      /** Step is flagged `unsafeForLocalModels` and the resolved provider is a
       *  local Ollama model. The UI renders an "Override and run" button that
       *  retries the step with `overrideLocalModel` set, bypassing the guard. */
      type: 'local_model_destructive';
      stepId: string;
      providerName: CliProviderName;
    }
  | {
      /** A CLI provider returned a fatal, non-retryable failure within this run
       *  (rate-limit/quota exhausted, persistent auth, or a 5xx/server outage), so the
       *  step was failed fast. The UI shows an "outage — retry when the provider
       *  recovers" banner instead of implying a code defect. `reason` mirrors the
       *  worker's ProviderFatalClass. */
      type: 'provider_unavailable';
      reason: 'rate_limit' | 'auth' | 'server_error';
      providerName?: CliProviderName;
    }
  | {
      /** Every rung of the escalating timeout ladder was spent: the step's CLI was
       *  SIGKILLed at its budget on each consecutive attempt without ever finishing.
       *  The UI renders a "Retry with longer timeout" button that re-runs the step with
       *  a user-chosen budget (task_steps.cli_timeout_override_ms).
       *
       *  Written from the failing INVOCATION's CLI_TIMEOUT_HEADLINE, never from the
       *  step's message copy — the hint is the structural proof of the state, the
       *  message is only the words in the banner. */
      type: 'cli_timeout';
      stepId: string;
      /** Budget of the last attempt, in whole minutes — the number the retry prompt
       *  should beat. */
      lastBudgetMinutes: number;
      /** How many consecutive timeouts were burned before giving up. */
      attempts: number;
    };

/** Per-invocation token usage captured from a CLI's structured output.
 *  Semantics are PROVIDER-NATIVE (later stats should normalize by provider):
 *  - claude-code/zai: inputTokens EXCLUDES cache reads/creation (raw API
 *    fields); totalTokens = input + output + cacheRead + cacheCreation.
 *    zai's costUsd is unreliable — the claude binary prices GLM traffic
 *    against Anthropic's price table; stored anyway for raw observability.
 *  - codex: inputTokens INCLUDES cached (OpenAI semantics); cacheReadTokens
 *    mirrors cached_input_tokens; totalTokens = input + output.
 *  - gemini: inputTokens = prompt (cached included); outputTokens =
 *    candidates + thoughts (thinking tokens are billed model output);
 *    totalTokens = the stats total (includes tool tokens). */
export interface CliTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

/** Which model actually answered a CLI invocation, as reported by the CLI itself.
 *
 *  `requested` and `served` are DIFFERENT channels, not two names for one value:
 *  the claude-family stream-json `system`/`init` event carries what the binary
 *  asked for, while each `assistant` event's `message.model` carries what the
 *  endpoint returned. They can disagree — MEASURED 2026-08-18, a provider
 *  configured for `glm-5.2[1m]` was served `glm-5.3` by api.z.ai with no config
 *  change on our side. Recording only one of them cannot detect that.
 *
 *  `requested` and `served` are always stored VERBATIM. Only `match` applies any
 *  leniency, and only one kind: an endpoint that drops a trailing variant tag while
 *  naming the same model (`glm-5.3[1m]` answered as `glm-5.3`) counts as 'exact'.
 *  Nothing else is folded — not case, not other suffixes, and not two different
 *  tags (`[1m]` vs `[200k]` stays 'differs', since a different context variant is a
 *  real difference). A version change such as `glm-5.2` -> `glm-5.3` is always
 *  'differs', which is the case the whole record exists to catch.
 *
 *  Per-provider coverage is measured, not assumed (see
 *  packages/worker/test/model-report-discover.ts, which re-measures it):
 *    - claude-code / zai / ollama / muse / grok / openrouter: both channels.
 *    - gemini: `stats.models` keys (served only).
 *    - antigravity: a human LABEL scraped from its own --log-file, never an id.
 *    - codex / amp: report NO model at all, so `served` stays null and `match`
 *      is 'unknown'. amp reports `agent_mode` instead; codex's `exec --json`
 *      carries no model on any typed event (verified against a full 3.4 MB run). */
export interface ModelIdentity {
  /** What we asked for: the CLI's own init event, else the provider config. */
  requested: string | null;
  /** What answered. Null when the CLI does not report it (codex, amp) or when the
   *  run failed before any assistant turn. */
  served: string | null;
  /** Every model billed for this run, including side calls the CLI makes on its
   *  own (claude-code bills a haiku call for session titling). Supplementary
   *  only — grok reports `grok-4.6-build` here while serving `grok-4.6`, so this
   *  is NOT an identity source. */
  billed: string[];
  /** Provenance of this record, so a reader can weigh it. The first three mean a
   *  CLI named the answering model; 'provider-config' means it did not, and only
   *  `requested` is known (codex, amp). Null when no channel said anything. */
  source: 'stream-json' | 'gemini-stats' | 'antigravity-log' | 'provider-config' | null;
  /** 'unknown' whenever `served` is null — those providers can never trip the
   *  strict-mode failure, because we have no evidence either way. */
  match: 'exact' | 'differs' | 'unknown';
}

export type RepoSource =
  'local_path' | 'git_https' | 'github_https' | 'github_oauth' | 'gitlab_https' | 'upload';

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';

export interface RepoJobPayload {
  repositoryId: string;
  userId: string;
  source: RepoSource;
  localPath?: string;
  remoteUrl?: string;
  branch?: string;
  credentialsId?: string;
  archivePath?: string;
  archiveFormat?: ArchiveFormat;
}

/* ------------------------------------------------------------------ */
/* Onboarding repo-level mirror (repositories.onboarding_*  +  .haive-data/)  */
/* ------------------------------------------------------------------ */

export const ONBOARDING_ENVIRONMENT_SCHEMA_VERSION = 1;
export const ONBOARDING_TOOLING_SCHEMA_VERSION = 1;

/** Machine-specific tooling keys stripped from the committed `.haive-data/tooling.json`
 *  mirror (they do not travel between machines). Kept in the DB column for LOCAL use. */
export const ONBOARDING_TOOLING_INFRA_KEYS = ['ragConnectionString', 'ollamaUrl'] as const;

/** Repo-level snapshot of an onboarded repo's detected+confirmed ENVIRONMENT.
 *  Persisted on `repositories.onboarding_environment` and mirrored to
 *  `.haive-data/environment.json`. Stores the RAW structures the stack resolvers
 *  already parse (`loadRepoStackAnchors` -> `resolveStackVersions`), so reading the
 *  column is a drop-in for the old "find onboarding task + read its 01/02 outputs"
 *  lookup that returns nothing after a fresh clone. */
export interface OnboardingEnvironmentMirror {
  schemaVersion: number;
  /** The `01-env-detect` detect `.data` object (project/container/stack/paths/...). */
  envDetectData: Record<string, unknown>;
  /** The `02-detection-confirmation` confirmed form values. */
  confirmedValues: Record<string, unknown>;
}

/** Repo-level snapshot of an onboarded repo's TOOLING prefs. Persisted on
 *  `repositories.onboarding_tooling` and mirrored (MINUS `ONBOARDING_TOOLING_INFRA_KEYS`)
 *  to `.haive-data/tooling.json`. `tooling` is the `04-tooling-infrastructure`
 *  `output.tooling` object (ragMode, embeddingModel, embeddingDimensions, ...). */
export interface OnboardingToolingMirror {
  schemaVersion: number;
  tooling: Record<string, unknown>;
}

export const ONBOARDING_EXCLUSIONS_SCHEMA_VERSION = 1;

/** Committed mirror of `repositories.scope_exclude_globs` (`.haive-data/exclusions.json`),
 *  so a fresh clone restores the onboarding/RAG scope denylist. DENYLIST semantics:
 *  unlisted paths stay in scope. Restored into the column on clone by persistDetection. */
export interface OnboardingExclusionsMirror {
  schemaVersion: number;
  scopeExcludeGlobs: string[];
}

/** The committed, clone-restored Haive data dir. Holds the onboarding mirror
 *  files below AND the project knowledge base + learnings (see
 *  `knowledge-paths.ts` for those). Distinct from `.haive/`, which workflow tasks
 *  add to `.git/info/exclude` and which therefore never travels with a clone.
 *
 *  HAIVE_DATA_FILES are the mirror files specifically: written at
 *  12-post-onboarding from the repo's onboarding_* columns and read back on clone
 *  by persistDetection. Kept here so both the writer (worker) and any reader share
 *  one source of truth for the filenames. */
export const HAIVE_DATA_DIR = '.haive-data';
export const HAIVE_DATA_FILES = {
  environment: `${HAIVE_DATA_DIR}/environment.json`,
  tooling: `${HAIVE_DATA_DIR}/tooling.json`,
  exclusions: `${HAIVE_DATA_DIR}/exclusions.json`,
} as const;

export type CustomBundleSourceType = 'zip' | 'git';
export type CustomBundleStatus = 'active' | 'syncing' | 'failed';
export type CustomBundleItemKind = 'agent' | 'skill';
export type CustomBundleItemSourceFormat = 'claude-md' | 'codex-toml' | 'gemini-md';

/** Job payload shared by all bundle-queue jobs. The job name discriminates
 *  between zip ingest, git ingest, and resync — handlers branch on
 *  `bundle.source_type` after loading the row. */
export interface BundleJobPayload {
  bundleId: string;
  userId: string;
  /** Set on first ingest (zip path) so the worker can rename the .partial-stripped
   *  archive into the bundle's storage root before extraction. Null for git jobs. */
  archivePath?: string;
  archiveFormat?: ArchiveFormat;
}
