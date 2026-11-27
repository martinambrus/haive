import { ollamaEmbed } from '@haive/shared/rag';

// Both interactive routes allow a cold embed: MEASURED 4.6–42.8 s (docs/architecture/global-kb.md).
export const OLLAMA_EMBED_PROBE_TIMEOUT_MS = 60_000;

export class OllamaProbeTimeoutError extends Error {
  constructor() {
    super('Embedding probe timed out; try again.');
    this.name = 'OllamaProbeTimeoutError';
  }
}

export async function probeGlobalKbEmbedding(
  url: string,
  model: string,
  opts: { fetchFn: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<number[][]> {
  const timeoutMs = opts.timeoutMs ?? OLLAMA_EMBED_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(opts.signal!.reason);
  opts.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (opts.signal?.aborted) forwardAbort();
  const timer = setTimeout(() => controller.abort(new OllamaProbeTimeoutError()), timeoutMs);
  let onAbort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    const embed = async () => {
      controller.signal.throwIfAborted();
      return ollamaEmbed(url, model, ['healthcheck'], {
        timeoutMs,
        fetchFn: (input, init) => {
          controller.signal.throwIfAborted();
          return opts.fetchFn(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([controller.signal, init.signal])
              : controller.signal,
          });
        },
      });
    };
    return await Promise.race([deadline, embed()]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}
