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
  'claude-code' | 'codex' | 'gemini' | 'amp' | 'zai' | 'antigravity' | 'ollama';

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

/** Relative paths of the committed onboarding-mirror files under `.haive-data/`.
 *  Written at 12-post-onboarding from the repo's onboarding_* columns; read back
 *  on clone by persistDetection. Kept here so both the writer (worker) and any
 *  reader share one source of truth for the filenames. */
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
