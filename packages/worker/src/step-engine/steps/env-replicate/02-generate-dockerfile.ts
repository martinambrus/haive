import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';
import {
  findEnvTemplateByHash,
  getTaskEnvTemplate,
  hashDockerfile,
  linkTaskToEnvTemplate,
} from './_shared.js';

export interface GenerateDockerfileDetect {
  envTemplateId: string;
  baseImage: string;
  declaredDeps: Record<string, unknown>;
  currentDockerfile: string;
}

export interface GenerateDockerfileApply {
  envTemplateId: string;
  dockerfileLength: number;
}

export const generateDockerfileStep: StepDefinition<
  GenerateDockerfileDetect,
  GenerateDockerfileApply
> = {
  metadata: {
    id: '02-generate-dockerfile',
    workflowType: 'env_replicate',
    index: 2,
    title: 'Generate Dockerfile',
    description:
      'Renders a Dockerfile from declared dependencies. The user can edit the result before building.',
    requiresCli: false,
  },

  async detect(ctx) {
    const row = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    if (!row) {
      throw new Error(
        `env template for task ${ctx.taskId} not found; declare-deps step must run first`,
      );
    }
    const declaredDeps = (row.declaredDeps ?? {}) as Record<string, unknown>;
    const dockerfile = row.generatedDockerfile ?? renderDockerfile(row.baseImage, declaredDeps);
    return {
      envTemplateId: row.id,
      baseImage: row.baseImage,
      declaredDeps,
      currentDockerfile: dockerfile,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Dockerfile',
      description: `Review and edit the generated Dockerfile based on ${detected.baseImage}.`,
      fields: [
        {
          type: 'textarea',
          id: 'dockerfile',
          label: 'Dockerfile',
          rows: 24,
          default: detected.currentDockerfile,
          required: true,
        },
      ],
      submitLabel: 'Save Dockerfile',
    };
  },

  async apply(ctx, args) {
    const dockerfile = String(args.formValues.dockerfile ?? '').trim();
    if (!dockerfile) throw new Error('dockerfile cannot be empty');
    const dockerfileHash = hashDockerfile(dockerfile);
    const currentId = args.detected.envTemplateId;

    const existingByHash = await findEnvTemplateByHash(ctx.db, ctx.userId, dockerfileHash);
    if (existingByHash && existingByHash.id !== currentId) {
      await linkTaskToEnvTemplate(ctx.db, ctx.taskId, existingByHash.id);
      await ctx.db.delete(schema.envTemplates).where(eq(schema.envTemplates.id, currentId));
      ctx.logger.info(
        {
          dedupedFrom: currentId,
          envTemplateId: existingByHash.id,
          dockerfileHash,
        },
        'env template deduped to existing hash',
      );
      return {
        envTemplateId: existingByHash.id,
        dockerfileLength: dockerfile.length,
      };
    }

    await ctx.db
      .update(schema.envTemplates)
      .set({
        generatedDockerfile: dockerfile,
        dockerfileHash,
        updatedAt: new Date(),
      })
      .where(eq(schema.envTemplates.id, currentId));
    ctx.logger.info(
      {
        envTemplateId: currentId,
        dockerfileLength: dockerfile.length,
        dockerfileHash,
      },
      'dockerfile saved',
    );
    return {
      envTemplateId: currentId,
      dockerfileLength: dockerfile.length,
    };
  },
};

type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'composer'
  | 'pip'
  | 'poetry'
  | 'uv'
  | 'pdm'
  | 'pipenv'
  | 'bundler'
  | 'gomod'
  | 'cargo';

interface DeclaredDepsShape {
  runtimes?: string[];
  versions?: {
    node?: string | null;
    php?: string | null;
    python?: string | null;
    java?: string | null;
  };
  packageManagers?: Partial<Record<string, PackageManager | null>>;
  preinstallDeps?: boolean;
  containerTool?: string;
  database?: { kind?: string; version?: string | null };
  lspServers?: string[];
  browserTesting?: boolean;
  extraPackages?: string[];
}

export function renderDockerfile(baseImage: string, rawDeps: Record<string, unknown>): string {
  const deps = rawDeps as DeclaredDepsShape;
  const lines: string[] = [];
  lines.push(`FROM ${baseImage}`);
  lines.push('');
  lines.push('ENV DEBIAN_FRONTEND=noninteractive');
  lines.push('');

  if (isDdevWebserverBase(baseImage)) {
    // ddev-webserver bundles the deb.sury.org PHP repo; sury rotates its
    // signing key periodically and the FIRST apt-get update aborts with
    // EXPKEYSIG until the bundled key is replaced. dpkg-installing sury's
    // official keyring deb refreshes the key and rewrites the source list
    // to use signed-by, fixing this in-place before any apt-get runs.
    lines.push('# Refresh sury.org PHP repo signing key (ddev-webserver ships sury preconfigured)');
    lines.push('RUN curl -fsSL https://packages.sury.org/debsuryorg-archive-keyring.deb \\');
    lines.push('        -o /tmp/sury-keyring.deb \\');
    lines.push('    && dpkg -i /tmp/sury-keyring.deb \\');
    lines.push('    && rm /tmp/sury-keyring.deb');
    lines.push('');
  }

  const basePackages = ['ca-certificates', 'curl', 'git', 'gnupg', 'bash', 'jq', 'ripgrep'];
  const extras = deps.extraPackages ?? [];
  const allPkgs = Array.from(new Set([...basePackages, ...extras]));
  lines.push('RUN apt-get update \\');
  lines.push(`    && apt-get install -y --no-install-recommends ${allPkgs.join(' ')} \\`);
  lines.push('    && rm -rf /var/lib/apt/lists/*');
  lines.push('');

  const declaredRuntimes = deps.runtimes ?? [];
  const versions = deps.versions ?? {};
  const lspServers = deps.lspServers ?? [];

  const lspNeedsNode = lspServers.some(
    (l) => l === 'intelephense' || l === 'intelephense-extended' || l === 'vtsls',
  );
  const browserNeedsNode = !!deps.browserTesting;
  const lspNeedsPython = lspServers.includes('pyright');
  const lspNeedsGo = lspServers.includes('gopls');
  const lspNeedsRust = lspServers.includes('rust-analyzer');
  const lspNeedsRuby = lspServers.includes('solargraph');

  const runtimes = new Set<string>(declaredRuntimes);
  if (lspNeedsNode || browserNeedsNode) runtimes.add('node');
  if (lspNeedsPython) runtimes.add('python');
  if (lspNeedsGo) runtimes.add('go');
  if (lspNeedsRust) runtimes.add('rust');
  if (lspNeedsRuby) runtimes.add('ruby');

  if (runtimes.has('node')) {
    const nodeMajor = (versions.node ?? '22').split('.')[0];
    lines.push(
      `# Node.js ${nodeMajor} (build-essential + python3 needed by node-gyp for native modules)`,
    );
    lines.push(`RUN curl -fsSL https://deb.nodesource.com/setup_${nodeMajor}.x | bash - \\`);
    lines.push(
      '    && apt-get install -y --no-install-recommends nodejs build-essential python3 pkg-config \\',
    );
    lines.push('    && rm -rf /var/lib/apt/lists/* \\');
    lines.push('    && corepack enable');
    lines.push('');
  }

  if (runtimes.has('php')) {
    const phpVersion = normalizePhpVersion(versions.php ?? '8.3');
    const isUbuntuBase = /^ubuntu:/i.test(baseImage);
    const needsSuryPpa = isUbuntuBase && phpVersion !== '8.3';
    lines.push(`# PHP ${phpVersion}`);
    lines.push('RUN apt-get update \\');
    if (needsSuryPpa) {
      lines.push(
        '    && apt-get install -y --no-install-recommends software-properties-common ca-certificates \\',
      );
      lines.push('    && add-apt-repository -y ppa:ondrej/php \\');
      lines.push('    && apt-get update \\');
    }
    lines.push(
      `    && apt-get install -y --no-install-recommends php${phpVersion}-cli php${phpVersion}-xml php${phpVersion}-mbstring php${phpVersion}-zip \\`,
    );
    lines.push('    && rm -rf /var/lib/apt/lists/*');
    lines.push('COPY --from=composer:2 /usr/bin/composer /usr/bin/composer');
    lines.push('');
  }

  if (runtimes.has('python')) {
    const pythonVersion = versions.python ?? '3.12';
    lines.push(`# Python ${pythonVersion}`);
    lines.push('RUN apt-get update \\');
    lines.push(
      '    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \\',
    );
    lines.push('    && rm -rf /var/lib/apt/lists/*');
    lines.push('');
  }

  if (runtimes.has('go')) {
    lines.push('# Go');
    lines.push(
      'RUN curl -fsSL https://go.dev/dl/go1.23.0.linux-amd64.tar.gz | tar -C /usr/local -xz',
    );
    lines.push('ENV PATH="/usr/local/go/bin:${PATH}"');
    lines.push('');
  }

  if (runtimes.has('rust')) {
    lines.push('# Rust');
    lines.push(
      'RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal',
    );
    lines.push('ENV PATH="/root/.cargo/bin:${PATH}"');
    lines.push('');
  }

  if (runtimes.has('ruby')) {
    lines.push('# Ruby');
    lines.push(
      'RUN apt-get update && apt-get install -y --no-install-recommends ruby ruby-dev && rm -rf /var/lib/apt/lists/*',
    );
    lines.push('');
  }

  if (runtimes.has('java')) {
    const javaVersion = versions.java ?? '17';
    const javaParts = javaVersion.split('.');
    const javaMajor = javaParts[0] === '1' && javaParts[1] ? javaParts[1] : (javaParts[0] ?? '17');
    lines.push(`# Java ${javaMajor}`);
    lines.push('RUN apt-get update \\');
    lines.push(
      `    && apt-get install -y --no-install-recommends openjdk-${javaMajor}-jdk-headless maven gradle \\`,
    );
    lines.push('    && rm -rf /var/lib/apt/lists/*');
    lines.push(
      `ENV JAVA_HOME="/usr/lib/jvm/java-${javaMajor}-openjdk-amd64" PATH="/usr/lib/jvm/java-${javaMajor}-openjdk-amd64/bin:\${PATH}"`,
    );
    lines.push('');
  }

  const database = deps.database;
  if (database && database.kind && database.kind !== 'none') {
    lines.push(`# Database client: ${database.kind}`);
    const dbPackage =
      database.kind === 'postgres'
        ? 'postgresql-client'
        : database.kind === 'sqlite'
          ? 'sqlite3'
          : 'default-mysql-client';
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${dbPackage} && rm -rf /var/lib/apt/lists/*`,
    );
    lines.push('');
  }

  if (lspServers.length > 0) {
    lines.push('# Language servers');
    for (const lsp of lspServers) {
      switch (lsp) {
        case 'intelephense':
          lines.push('RUN npm install -g intelephense');
          break;
        case 'intelephense-extended':
          lines.push('RUN npm install -g intelephense');
          break;
        case 'vtsls':
          lines.push('RUN npm install -g @vtsls/language-server typescript');
          break;
        case 'pyright':
          lines.push('RUN pip install --break-system-packages pyright');
          break;
        case 'gopls':
          lines.push('RUN go install golang.org/x/tools/gopls@latest');
          break;
        case 'rust-analyzer':
          lines.push('RUN rustup component add rust-analyzer');
          break;
        case 'solargraph':
          lines.push('RUN gem install solargraph');
          break;
        case 'jdtls':
          lines.push(
            'RUN curl -fsSL https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz -o /tmp/jdtls.tar.gz \\',
          );
          lines.push('    && mkdir -p /opt/jdtls \\');
          lines.push('    && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls \\');
          lines.push('    && rm /tmp/jdtls.tar.gz \\');
          lines.push('    && ln -s /opt/jdtls/bin/jdtls /usr/local/bin/jdtls');
          break;
      }
    }
    lines.push('');
  }

  if (deps.browserTesting) {
    lines.push('# Chrome + chrome-devtools-mcp');
    lines.push('RUN apt-get update \\');
    lines.push('    && apt-get install -y --no-install-recommends chromium xvfb \\');
    lines.push('    && rm -rf /var/lib/apt/lists/*');
    lines.push('RUN npm install -g chrome-devtools-mcp');
    lines.push('');
  }

  lines.push('WORKDIR /workspace');
  lines.push('');

  if (deps.preinstallDeps && deps.packageManagers) {
    for (const [language, manager] of Object.entries(deps.packageManagers)) {
      if (!manager) continue;
      const block = renderDepInstallBlock(language, manager);
      if (block.length === 0) continue;
      lines.push(`# Project dependencies (${language} via ${manager})`);
      lines.push(...block);
      lines.push('');
    }
  }

  lines.push('CMD ["bash"]');

  return lines.join('\n') + '\n';
}

function isDdevWebserverBase(baseImage: string): boolean {
  return /^ddev\/ddev-webserver(:|$)/i.test(baseImage);
}

function normalizePhpVersion(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '').trim();
  const parts = cleaned.split('.').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  if (parts.length === 1 && parts[0]) return parts[0];
  return '8.3';
}

function renderDepInstallBlock(language: string, manager: PackageManager): string[] {
  switch (manager) {
    case 'npm':
      return ['COPY package.json package-lock.json ./', 'RUN npm ci --omit=dev'];
    case 'pnpm':
      return ['COPY package.json pnpm-lock.yaml ./', 'RUN pnpm install --frozen-lockfile --prod'];
    case 'yarn':
      return ['COPY package.json yarn.lock ./', 'RUN yarn install --frozen-lockfile --production'];
    case 'bun':
      return [
        'RUN curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun',
        'COPY package.json bun.lockb ./',
        'RUN bun install --frozen-lockfile --production',
      ];
    case 'composer':
      return [
        'COPY composer.json composer.lock ./',
        'RUN composer install --no-dev --prefer-dist --no-scripts --no-progress',
      ];
    case 'pip':
      return [
        'COPY requirements.txt ./',
        'RUN pip install --break-system-packages --no-cache-dir -r requirements.txt',
      ];
    case 'poetry':
      return [
        'RUN pip install --break-system-packages --no-cache-dir poetry',
        'COPY pyproject.toml poetry.lock ./',
        'RUN poetry config virtualenvs.create false && poetry install --no-root --only main',
      ];
    case 'uv':
      return [
        'RUN pip install --break-system-packages --no-cache-dir uv',
        'COPY pyproject.toml uv.lock ./',
        'RUN uv sync --no-dev --frozen',
      ];
    case 'pdm':
      return [
        'RUN pip install --break-system-packages --no-cache-dir pdm',
        'COPY pyproject.toml pdm.lock ./',
        'RUN pdm install --prod --no-lock',
      ];
    case 'pipenv':
      return [
        'RUN pip install --break-system-packages --no-cache-dir pipenv',
        'COPY Pipfile Pipfile.lock ./',
        'RUN pipenv install --deploy --system',
      ];
    case 'bundler':
      return [
        'COPY Gemfile Gemfile.lock ./',
        'RUN bundle config set --local without "development test" && bundle install',
      ];
    case 'gomod':
      return ['COPY go.mod go.sum ./', 'RUN go mod download'];
    case 'cargo':
      return [
        'COPY Cargo.toml Cargo.lock ./',
        'RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo fetch && rm -rf src',
      ];
    default:
      void language;
      return [];
  }
}
