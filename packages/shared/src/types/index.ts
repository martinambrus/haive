export type WorkflowType = 'onboarding' | 'workflow' | 'onboarding_upgrade';

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_form'
  | 'waiting_cli'
  | 'done'
  | 'failed'
  | 'skipped';

export type CliProviderName =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'amp'
  | 'zai'
  | 'antigravity'
  | 'ollama';

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
  | 'local_path'
  | 'git_https'
  | 'github_https'
  | 'github_oauth'
  | 'gitlab_https'
  | 'upload';

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
