import { logger } from '@haive/shared';
import { getOllamaModelPlacement } from '@haive/shared/rag';

type Logger = ReturnType<typeof logger.child>;

export type EmbedDevice = 'gpu' | 'cpu' | 'unknown';

/** True when the stack was booted in GPU mode. docker-compose.gpu.yml — layered by
 *  scripts/dev.sh (pnpm docker:dev) only when an NVIDIA GPU and the nvidia container runtime are
 *  present — sets HAIVE_GPU_EXPECTED=1 on the worker. CPU-only hosts never load
 *  that file, so the flag stays unset and the CPU-fallback check is skipped. This
 *  keys on the deliberate compose flag (the invariant), not on ephemeral
 *  `nvidia-smi` output. */
export function isGpuExpected(): boolean {
  return process.env.HAIVE_GPU_EXPECTED === '1';
}

/** Detect whether the embedding model loaded on the GPU or silently fell back to
 *  CPU, warning loudly on a CPU fallback in GPU mode. Call right after the model
 *  is warmed (so it is resident and `/api/ps` can report its placement). A CPU
 *  fallback while a GPU was expected means a long RAG populate is running far
 *  slower than it should, usually from a GPU driver/runtime mismatch (host driver
 *  upgraded without a reboot). Returns 'unknown' on CPU-only hosts (no GPU
 *  expected) or when placement can't be determined — never warns falsely. */
export async function detectEmbedDevice(
  log: Logger,
  ollamaUrl: string,
  model: string,
): Promise<EmbedDevice> {
  if (!isGpuExpected()) return 'unknown';
  const placement = await getOllamaModelPlacement(ollamaUrl, model);
  if (placement === 'cpu') {
    log.warn(
      { model },
      'Embedding model loaded on CPU despite GPU mode — likely a GPU driver/runtime mismatch ' +
        '(e.g. the host GPU driver was upgraded without a reboot). RAG embeddings will be slow. ' +
        'Fix: from Windows run `wsl --shutdown`, restart Docker Desktop and re-run `pnpm docker:dev`, or reboot.',
    );
    return 'cpu';
  }
  if (placement === 'gpu') return 'gpu';
  return 'unknown';
}

/** User-facing advisory for a step's warning banner, or null when there is
 *  nothing to warn about. Only a CPU fallback (under GPU mode) warrants one. */
export function embedDeviceWarning(device: EmbedDevice): string | null {
  if (device !== 'cpu') return null;
  return (
    'GPU unavailable — embeddings are running on the CPU, so RAG indexing is much ' +
    'slower than usual. This usually means the host GPU driver was upgraded without ' +
    'a reboot. To restore GPU speed: from Windows run `wsl --shutdown`, restart Docker ' +
    'Desktop and re-run `pnpm docker:dev` (or reboot). Indexing will still finish either way.'
  );
}
