export type WorkflowType = 'onboarding' | 'workflow';

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
