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
    reuseLastCompletedFormValues: true,
  },

  async detect(ctx) {
    const row = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    if (!row) {
      throw new Error(
        `env template for task ${ctx.taskId} not found; declare-deps step must run first`,
      );
    }
    const declaredDeps = (row.declaredDeps ?? {}) as Record<string, unknown>;
    // Reuse a previously-saved Dockerfile, EXCEPT when it still targets a PHP
    // version no apt repo can install (the pre-fix php<5.6 output). Such a
    // Dockerfile can never build, so re-render from declared deps — which now
    // floors PHP to 5.6 — so the step self-heals on retry instead of the user
    // having to hand-edit it. A re-rendered Dockerfile is buildable, so this
    // does not loop.
    const saved = row.generatedDockerfile;
    const dockerfile =
      saved && !dockerfileTargetsUnbuildablePhp(saved)
        ? saved
        : renderDockerfile(row.baseImage, declaredDeps);
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
  /** Per-LSP version pins, keyed by lsp key (e.g. intelephense, vtsls, pyright,
   *  gopls, solargraph). Bare version string; absent/empty = latest/unpinned.
   *  rust-analyzer and jdtls are not pinnable and ignore any value here. */
  lspServerVersions?: Record<string, string | null>;
  browserTesting?: boolean;
  /** chrome-devtools-mcp npm version pin baked into the env image (warm cache).
   *  Absent/empty = latest. The operative runtime pin is applied separately when
   *  the MCP server is launched (resolveMcpExtraFiles → buildDefaultMcpServers). */
  chromeDevtoolsMcpVersion?: string | null;
  extraPackages?: string[];
}

export function renderDockerfile(baseImage: string, rawDeps: Record<string, unknown>): string {
  const deps = rawDeps as DeclaredDepsShape;
  const lines: string[] = [];
  lines.push(`FROM ${baseImage}`);
  lines.push('');
  lines.push('ENV DEBIAN_FRONTEND=noninteractive');
  lines.push('');
  // Make every apt install below fully non-interactive on conffile conflicts by
  // auto-keeping the currently-installed conffile. DEBIAN_FRONTEND alone does
  // NOT answer the dpkg "modified conffile" prompt, so a base that ships a
  // package whose conffile differs from the new one (e.g. ddev-webserver's
  // php*-fpm and its php-fpm.conf) aborts the build at the Y/I/N/O/D/Z prompt
  // with "end of file on stdin at conffile prompt".
  lines.push('# Auto-keep existing conffiles so apt never blocks the build on a prompt');
  lines.push(
    'RUN echo \'Dpkg::Options { "--force-confold"; "--force-confdef"; };\' > /etc/apt/apt.conf.d/99haive-noninteractive',
  );
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

  // For DDEV projects the PHP runtime comes from DDEV itself (01c-ddev-env), not
  // this sandbox image — so skip the apt install entirely (DDEV serves php 5.6/7/8
  // from its own images; apt-installing legacy PHP on the base would just fail).
  if (runtimes.has('php') && deps.containerTool !== 'ddev') {
    const requestedPhp = normalizePhpVersion(versions.php ?? '8.3');
    const phpVersion = clampPhpToInstallable(requestedPhp);
    const bumped = phpVersion !== requestedPhp;
    const isUbuntuBase = /^ubuntu:/i.test(baseImage);
    const needsSuryPpa = isUbuntuBase && phpVersion !== '8.3';
    if (bumped) {
      // PHP < 5.6 is EOL and carried by no maintained apt repo (ondrej/sury
      // both floor at 5.6, as does DDEV), so the apt install would fail. Floor
      // to 5.6 — a near-perfectly-compatible bump for 5.5-era code — and leave
      // a visible note so the user can switch to a legacy base image if they
      // truly need the exact version.
      lines.push(`# WARNING: PHP ${requestedPhp} is end-of-life and unavailable from any apt repo`);
      lines.push('#          (ondrej/sury and DDEV both floor at PHP 5.6). Using PHP 5.6 instead.');
      lines.push('#          For an exact legacy build, replace the FROM line above with a');
      lines.push(
        `#          legacy PHP image (e.g. FROM php:${requestedPhp}-cli) and adjust extensions.`,
      );
    }
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

  // DDEV runs the database service itself; the CLI sandbox needs no client for it.
  const database = deps.database;
  if (database && database.kind && database.kind !== 'none' && deps.containerTool !== 'ddev') {
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
    const lspVersions = deps.lspServerVersions ?? {};
    lines.push('# Language servers');
    for (const lsp of lspServers) {
      // Bare version pin for this server; empty/absent = latest/unpinned.
      const v = (lspVersions[lsp] ?? '').trim();
      switch (lsp) {
        case 'intelephense':
          lines.push(`RUN npm install -g intelephense${v ? `@${v}` : ''}`);
          break;
        case 'intelephense-extended':
          lines.push(`RUN npm install -g intelephense${v ? `@${v}` : ''}`);
          break;
        case 'vtsls':
          lines.push(`RUN npm install -g @vtsls/language-server${v ? `@${v}` : ''} typescript`);
          break;
        case 'pyright':
          lines.push(`RUN pip install --break-system-packages pyright${v ? `==${v}` : ''}`);
          break;
        case 'gopls':
          // gopls module tags are vX.Y.Z; the cache stores the bare version.
          lines.push(`RUN go install golang.org/x/tools/gopls@${v ? `v${v}` : 'latest'}`);
          break;
        case 'rust-analyzer':
          // Not independently pinnable (tied to the rustup toolchain).
          lines.push('RUN rustup component add rust-analyzer');
          break;
        case 'solargraph':
          lines.push(`RUN gem install solargraph${v ? ` -v ${v}` : ''}`);
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
    // Headed-browser desktop stack so the per-task app-runner can run the app
    // AND serve a live noVNC view (08a-browser-verify + Gate 2), the same way
    // the DDEV runner does: Chromium on an Xvfb display, x11vnc for the VNC
    // bridge, socat to expose the localhost-only CDP port, puppeteer-core for
    // the probe scripts. chrome-devtools-mcp powers the agent (mcp) mode. The
    // worker injects the desktop launcher + probe scripts into the running
    // container via `docker cp` (they can't be COPYed here — the env-image build
    // context is the repo, not the worker's docker assets).
    lines.push('# Browser testing: headed Chromium + Xvfb/x11vnc/socat + puppeteer-core');
    lines.push('RUN apt-get update \\');
    lines.push(
      '    && apt-get install -y --no-install-recommends chromium xvfb x11vnc socat procps fonts-dejavu \\',
    );
    lines.push('    && rm -rf /var/lib/apt/lists/*');
    const cdmVersion = (deps.chromeDevtoolsMcpVersion ?? '').trim();
    lines.push(`RUN npm install -g chrome-devtools-mcp${cdmVersion ? `@${cdmVersion}` : ''}`);
    lines.push(
      'RUN mkdir -p /opt/browser && cd /opt/browser && npm init -y >/dev/null 2>&1 && npm install puppeteer-core@22 >/dev/null 2>&1',
    );
    lines.push('ENV CHROME_PATH=/usr/bin/chromium');
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

// PHP 5.6 is the lowest version any maintained apt repo provides (ondrej PPA
// and deb.sury.org both floor at 5.6, matching DDEV's own minimum), so anything
// older cannot be apt-installed onto the Ubuntu or ddev-webserver bases. Floor
// to 5.6 so the generated Dockerfile actually builds; the caller emits a
// warning comment when this kicks in. Expects a normalized "maj" or "maj.min".
function clampPhpToInstallable(version: string): string {
  const parts = version.split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(major)) return version;
  const belowFloor = major < 5 || (major === 5 && (!Number.isFinite(minor) || minor < 6));
  return belowFloor ? '5.6' : version;
}

// True when a Dockerfile asks apt to install a PHP package below the 5.6 floor
// (e.g. "php5.5-cli", "php5.4-mbstring") — the pre-fix generator output that no
// repo can resolve. Drives self-healing re-render in detect(). Deliberately
// matches only the apt package form "phpX.Y-<ext>": the colon form
// "php:5.5-cli" used in the warning comment's legacy escape hatch is NOT
// matched, so a re-rendered (already-floored) Dockerfile is never flagged and
// the re-render cannot loop.
export function dockerfileTargetsUnbuildablePhp(dockerfile: string): boolean {
  return /\bphp(5\.[0-5]|[0-4]\.\d+)-[a-z]/.test(dockerfile);
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
