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

export type CliProviderName = 'claude-code' | 'codex' | 'gemini' | 'amp' | 'zai';

export type AuthMode = 'subscription' | 'api_key' | 'mixed';

/**
 * Structured hint attached to a failed task_step so the UI can render
 * actionable recovery affordances (e.g. a "Log in to CLI" button) instead of
 * a plain text error. Discriminated on `type` — new kinds can be added without
 * breaking existing consumers.
 */
export type StepErrorHint = {
  type: 'cli_login_required';
  providerId: string;
  providerName: CliProviderName;
};

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
