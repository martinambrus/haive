export const APP_NAME = 'Haive';
export const APP_VERSION = '0.1.0';

export const QUEUE_NAMES = {
  TASK: 'haive-task',
  CLI_EXEC: 'haive-cli-exec',
  ENV_REPLICATE: 'haive-env-replicate',
  REPO: 'haive-repo',
} as const;

export const REPO_JOB_NAMES = {
  CLONE: 'clone-repo',
  SCAN: 'scan-repo',
  EXTRACT: 'extract-repo',
} as const;

export const TASK_JOB_NAMES = {
  START: 'start-task',
  ADVANCE_STEP: 'advance-step',
  CANCEL: 'cancel-task',
} as const;

export interface TaskJobPayload {
  taskId: string;
  userId: string;
  stepId?: string;
  formValues?: Record<string, unknown>;
}

export const CLI_EXEC_JOB_NAMES = {
  INVOKE: 'cli-invoke',
} as const;

export type CliExecInvocationKind = 'cli' | 'api' | 'subagent_native' | 'subagent_sequential';

export interface CliExecJobPayload {
  invocationId: string;
  taskId: string;
  taskStepId: string | null;
  userId: string;
  cliProviderId: string | null;
  kind: CliExecInvocationKind;
  spec: unknown;
  timeoutMs?: number;
}

export const PUBSUB_CHANNELS = {
  TASK_PROGRESS: 'haive:task-progress',
  CLI_OUTPUT: 'haive:cli-output',
  TERMINAL: 'haive:terminal',
} as const;

export const FRAMEWORK_PATTERNS = {
  wordpress: {
    indicators: ['wp-content/', 'wp-admin/', 'wp-includes/'],
    excludePaths: ['wp-admin/', 'wp-includes/', 'wp-content/plugins/', 'wp-content/themes/'],
    customPaths: ['wp-content/themes/'],
  },
  drupal: {
    indicators: ['core/', 'modules/', 'themes/', 'sites/'],
    excludePaths: ['core/', 'modules/contrib/', 'themes/contrib/', 'vendor/'],
    customPaths: ['modules/custom/', 'themes/custom/'],
  },
  drupal7: {
    indicators: ['sites/all/modules/', 'sites/all/themes/', 'includes/bootstrap.inc'],
    excludePaths: ['sites/all/libraries/', 'sites/default/files/', 'includes/'],
    customPaths: ['sites/all/modules/custom/', 'sites/all/themes/custom/'],
  },
  rails: {
    indicators: ['Gemfile', 'app/', 'config/', 'db/'],
    excludePaths: ['vendor/', 'tmp/', 'log/'],
    customPaths: ['app/', 'lib/', 'config/'],
  },
  laravel: {
    indicators: ['artisan', 'composer.json', 'app/', 'routes/'],
    excludePaths: ['vendor/', 'storage/', 'bootstrap/cache/'],
    customPaths: ['app/', 'routes/', 'resources/', 'config/', 'database/'],
  },
  nodejs: {
    indicators: ['package.json', 'node_modules/'],
    excludePaths: ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/'],
    customPaths: ['src/', 'lib/', 'app/'],
  },
  nextjs: {
    indicators: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'app/', 'pages/'],
    excludePaths: ['node_modules/', '.next/', 'out/', 'coverage/'],
    customPaths: ['src/', 'app/', 'pages/', 'components/'],
  },
  python: {
    indicators: ['requirements.txt', 'setup.py', 'pyproject.toml'],
    excludePaths: ['venv/', '.venv/', 'site-packages/', '__pycache__/', '.tox/'],
    customPaths: ['src/', 'app/', 'lib/'],
  },
  django: {
    indicators: ['manage.py', 'settings.py', 'wsgi.py'],
    excludePaths: ['venv/', '.venv/', 'static/', 'media/', 'migrations/'],
    customPaths: ['src/', 'apps/'],
  },
  go: {
    indicators: ['go.mod', 'go.sum'],
    excludePaths: ['vendor/', 'bin/'],
    customPaths: ['cmd/', 'internal/', 'pkg/'],
  },
  rust: {
    indicators: ['Cargo.toml', 'Cargo.lock', 'src/'],
    excludePaths: ['target/'],
    customPaths: ['src/', 'crates/'],
  },
  general: {
    indicators: [],
    excludePaths: ['.git/', '.svn/', '.hg/', '.DS_Store', 'Thumbs.db'],
    customPaths: [],
  },
} as const;

export type FrameworkName = keyof typeof FRAMEWORK_PATTERNS;

export const DEFAULT_EXCLUDED_PATTERNS = [
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.gif',
  '*.ico',
  '*.svg',
  '*.webp',
  '*.mp3',
  '*.mp4',
  '*.wav',
  '*.avi',
  '*.mov',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.7z',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.min.js',
  '*.min.css',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
] as const;
