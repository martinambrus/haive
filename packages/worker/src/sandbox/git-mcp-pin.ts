import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DockerRunner } from './docker-runner.js';
import { sandboxImageContextDir } from './sandbox-image-context.js';

/** The mcp-server-git release baked into every sandbox image. Must equal the pin in
 *  sandbox-image/git-mcp-requirements.txt; git-mcp-baked.test.ts enforces it. */
export const GIT_MCP_SERVER_VERSION = '2026.11.11';

/** Interpreter of the venv the baked install lives in. Nothing is fetched when it starts. */
export const GIT_MCP_PYTHON = `/opt/haive-git-mcp-${GIT_MCP_SERVER_VERSION}/venv/bin/python`;

/** Image label naming the baked release. The worker declares the git server only for an image
 *  that carries it. */
export const GIT_MCP_IMAGE_LABEL = 'haive.git-mcp';

/** Files the install layer copies, in digest order. */
const GIT_MCP_CONTEXT_FILES = ['git-mcp-requirements.txt', 'install-git-mcp.sh'] as const;

/** Dockerfile layer that installs the git MCP server. The digest of its two input files is a
 *  comment in the layer, so a bumped lock or script moves the composed image tag. Read on every
 *  call: the files are not watched sources, and a cached digest would keep an edit from taking
 *  effect until the worker restarted. */
export function buildGitMcpLayer(): string {
  const dir = sandboxImageContextDir();
  const hash = createHash('sha256');
  for (const name of GIT_MCP_CONTEXT_FILES) {
    hash
      .update(name + '\0')
      .update(readFileSync(path.join(dir, name)))
      .update('\0');
  }
  return [
    `# haive-git-mcp-context: sha256:${hash.digest('hex')}`,
    `COPY ${GIT_MCP_CONTEXT_FILES.join(' ')} /tmp/haive-git-mcp/`,
    'RUN sh /tmp/haive-git-mcp/install-git-mcp.sh && rm -rf /tmp/haive-git-mcp',
    `LABEL ${GIT_MCP_IMAGE_LABEL}="${GIT_MCP_SERVER_VERSION}"`,
  ].join('\n');
}

/** Puts the layer's COPY sources next to the Dockerfile a composed build is run from. */
export function writeGitMcpContext(buildDir: string): void {
  const dir = sandboxImageContextDir();
  for (const name of GIT_MCP_CONTEXT_FILES)
    copyFileSync(path.join(dir, name), path.join(buildDir, name));
}

/** Whether the server's baked tree can be assumed present in this image. A verified composed
 *  image keeps its tag and an operator may pin SANDBOX_IMAGE, so an image built before the layer
 *  existed can still be launched; declaring the server there makes the CLI report it failed and
 *  the run is discarded. Fails open when the image is unknown or cannot be inspected: nothing
 *  says the tree is missing, so the server is declared as designed. */
export async function imageCarriesGitMcp(
  image: string | null,
  runner: Pick<DockerRunner, 'inspect'>,
): Promise<boolean> {
  if (image === null) return true;
  try {
    const inspected = await runner.inspect(image);
    if (!inspected.exists) return true;
    return inspected.labels?.[GIT_MCP_IMAGE_LABEL] === GIT_MCP_SERVER_VERSION;
  } catch {
    return true;
  }
}
