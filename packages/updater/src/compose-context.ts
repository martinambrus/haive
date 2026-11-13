import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComposeContext } from './docker.js';

/** Preserve the installed overlay: the updater container cannot detect the host's GPU.
 * NVIDIA precedes Vulkan, matching the installer's selection for the generated helper. */
export async function readComposeContext(dir: string): Promise<ComposeContext> {
  const files = ['docker-compose.yml', 'docker-compose.run.yml'];
  for (const overlay of ['docker-compose.gpu.yml', 'docker-compose.vulkan.yml']) {
    // This is the operator's install directory, not a sandbox-writable repository path.
    const installed = await stat(join(dir, overlay)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (installed?.isFile()) {
      files.push(overlay);
      break;
    }
  }
  return { dir, files };
}
