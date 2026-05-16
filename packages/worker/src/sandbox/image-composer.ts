import { createHash } from 'node:crypto';
import type { CliProviderName } from '@haive/shared';
import { buildProviderInstallLines } from '../cli-versions/codegen.js';

export const SANDBOX_CORE_IMAGE = 'haive-cli-sandbox:latest';

export interface SandboxImageComposition {
  tag: string;
  hash: string;
  dockerfileBody: string;
  hasEnvTemplate: boolean;
  hasCliInstall: boolean;
  hasExtras: boolean;
}

export interface ComposeInput {
  envTemplateDockerfile: string | null;
  provider: {
    name: CliProviderName;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  };
  /**
   * Current image ID (sha256:...) of the SANDBOX_CORE_IMAGE base. When a
   * dockerfile body references the base by tag (`haive-cli-sandbox:latest`),
   * the tag itself is mutable — rebuilding the base produces a new image but
   * keeps the same tag, so a hash over the dockerfile body alone fails to
   * invalidate composed image tags. Mixing the base ID into the hash forces
   * a fresh tag on base rebuild. Caller passes `null` (or omits) when the
   * base image isn't yet built or the env-template doesn't reference it.
   */
  baseImageId?: string | null;
}

export function composeSandboxImage(input: ComposeInput): SandboxImageComposition {
  const extra = (input.provider.sandboxDockerfileExtra ?? '').trim();
  const codegen = buildProviderInstallLines(input.provider.name, input.provider.cliVersion);
  const installLines = codegen.supported ? codegen.lines : [];

  const base = resolveBase(input.envTemplateDockerfile);
  const parts: string[] = [base];
  // Haive-required runtime tools that the user CLI session relies on,
  // independent of the env-template's project deps. Currently: `uv`/`uvx`
  // for spawning the `mcp-server-git` MCP server claude-code wires up at
  // startup. The env-template ships `apt-get` (debian/ubuntu) most of the
  // time but doesn't know about haive-side MCP requirements; the
  // sandbox-core base (haive-cli-sandbox) installs `uv` from apk but only
  // applies when there is no env-template. Inject the install here so
  // composed images built on top of env-templates get it too.
  parts.push(buildHaiveRuntimeToolsLayer());
  if (installLines.length > 0) parts.push(installLines.join('\n'));
  if (extra.length > 0) parts.push(extra);

  const dockerfileBody = `${parts.join('\n\n')}\n`;

  const referencesSandboxBase =
    input.envTemplateDockerfile === null || dockerfileBody.includes(SANDBOX_CORE_IMAGE);
  const baseIdForHash = referencesSandboxBase && input.baseImageId ? input.baseImageId : '';
  const hashInput =
    baseIdForHash.length > 0 ? `${baseIdForHash}\n${dockerfileBody}` : dockerfileBody;
  const hash = createHash('sha256').update(hashInput, 'utf8').digest('hex').slice(0, 16);

  return {
    tag: `haive-sandbox:${hash}`,
    hash,
    dockerfileBody,
    hasEnvTemplate: input.envTemplateDockerfile !== null,
    hasCliInstall: installLines.length > 0,
    hasExtras: extra.length > 0,
  };
}

function resolveBase(envTemplateDockerfile: string | null): string {
  if (!envTemplateDockerfile) return `FROM ${SANDBOX_CORE_IMAGE}`;
  return envTemplateDockerfile.trimEnd();
}

/** rtk binary version + sha for env-template-derived composed images.
 *  MUST stay in sync with the ARG values in
 *  `packages/worker/sandbox-image/Dockerfile` — both layers download the
 *  same tarball so behaviour matches whether the base image is the
 *  haive-cli-sandbox core or a project env-template. The musl binary is
 *  statically linked, so the same artifact works on Alpine and on
 *  Debian/Ubuntu env-templates. */
const RTK_RELEASE_VERSION = 'v0.37.2';
const RTK_X86_64_MUSL_SHA256 = '3dfb7a05636a68687ba1c5aa696fa8d5fcb494447ded86d9eb8b88b7100a37c6';

/** Idempotent install layer for the haive-side runtime tools the CLI session
 *  needs but that the env-template won't necessarily ship. Currently:
 *   - `uv`/`uvx`: spawning the `mcp-server-git` MCP server claude-code wires
 *     up at startup.
 *   - `ripgrep`/`rg`: gemini's GrepTool falls back to a slower built-in
 *     scanner when `rg` is absent and emits a "Ripgrep is not available.
 *     Falling back to GrepTool" line on every search.
 *   - `nano`: default editor for the interactive Terminal tab so users can
 *     edit files directly in the shell. Without it the env-template often
 *     ships only `vi`/`vim` (or nothing), which is a worse default.
 *   - `tmux`: every Terminal WS attaches to a single per-container tmux
 *     session ("haive-task") instead of spawning a fresh `bash -l`. That's
 *     what gives "navigate-away-and-back" true persistence — env vars,
 *     cwd, running foreground process, and pane buffer all survive the
 *     reconnect because the bash + tmux server live independent of any WS.
 *   - `rtk`: token-killer hook binary referenced by every project-level
 *     `.claude/settings.json` rendered with `rtk_enabled=true`. Without
 *     it claude/zai run a PreToolUse hook that fails with
 *     `rtk: not found` on every Bash invocation. Pulled from the same
 *     pinned musl tarball as the sandbox-core image.
 *  Auto-detects the package manager so the same line works on alpine (apk)
 *  and debian/ubuntu (apt). Falls back to the official uv installer when
 *  neither is present (rg / nano / tmux have no upstream tarball install
 *  path here, so they are skipped silently on bespoke base images). The
 *  `command -v` short-circuits make re-runs cheap; ALL tools must be
 *  present for the early exit. Idempotent on its own line so a change
 *  here forces a clean cache miss across all composed images. */
function buildHaiveRuntimeToolsLayer(): string {
  const rtkUrl = `https://github.com/rtk-ai/rtk/releases/download/${RTK_RELEASE_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz`;
  return [
    'RUN set -eux; \\',
    '    if command -v uvx >/dev/null 2>&1 && command -v rg >/dev/null 2>&1 && command -v nano >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 && command -v rtk >/dev/null 2>&1; then exit 0; fi; \\',
    '    if command -v apk >/dev/null 2>&1; then \\',
    '        apk add --no-cache uv ripgrep nano tmux curl ca-certificates; \\',
    '    elif command -v apt-get >/dev/null 2>&1; then \\',
    '        apt-get update; \\',
    '        apt-get install -y --no-install-recommends curl ca-certificates ripgrep nano tmux; \\',
    '        if ! command -v uvx >/dev/null 2>&1; then \\',
    '            curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh; \\',
    '        fi; \\',
    '        rm -rf /var/lib/apt/lists/*; \\',
    '    else \\',
    '        echo "haive-runtime-tools: no apk/apt — uv/ripgrep/nano/tmux install skipped" >&2; \\',
    '    fi; \\',
    '    if ! command -v rtk >/dev/null 2>&1; then \\',
    '        arch="$(uname -m)"; \\',
    '        case "$arch" in \\',
    '          x86_64) \\',
    `            curl -fsSL "${rtkUrl}" -o /tmp/rtk.tgz; \\`,
    `            echo "${RTK_X86_64_MUSL_SHA256}  /tmp/rtk.tgz" | sha256sum -c -; \\`,
    '            tar -xzf /tmp/rtk.tgz -C /tmp; \\',
    '            install -m 0755 "$(find /tmp -maxdepth 3 -type f -name rtk -perm -u+x | head -n1)" /usr/local/bin/rtk; \\',
    '            rm -rf /tmp/rtk.tgz /tmp/rtk-*; \\',
    '            /usr/local/bin/rtk --version; \\',
    '            ;; \\',
    '          *) \\',
    `            echo "rtk: skipping install on unsupported arch '$arch' (no musl asset upstream)" >&2; \\`,
    '            ;; \\',
    '        esac; \\',
    '    fi',
  ].join('\n');
}
