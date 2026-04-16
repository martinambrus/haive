export type WorkflowType = 'onboarding' | 'workflow' | 'env_replicate';

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'paused'
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
  | 'grok'
  | 'qwen'
  | 'kiro'
  | 'zai';

export type AuthMode = 'subscription' | 'api_key' | 'mixed';

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
