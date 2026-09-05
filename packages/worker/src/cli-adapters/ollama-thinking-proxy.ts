import { isOllamaCloudModel } from '@haive/shared';

/** Address of the in-stack `ollama-thinking-proxy` sidecar (docker-compose
 *  service of the same name). When a provider's "Disable model thinking" toggle is
 *  on, the ollama adapter points that invocation's ANTHROPIC_BASE_URL here instead
 *  of ollama.com; the proxy injects thinking:{type:"disabled"} into /v1/messages
 *  and forwards to ollama.com. The sandbox runner exempts the host from the egress
 *  (squid) proxy so the claude binary reaches it directly over haive-sandbox.
 *
 *  Dependency-free so both cli-adapters (ollama.ts) and sandbox (sandbox-runner.ts)
 *  can import it without pulling adapter internals. */
export const OLLAMA_THINKING_PROXY_HOST =
  process.env.OLLAMA_THINKING_PROXY_HOST || 'ollama-thinking-proxy';

export const OLLAMA_THINKING_PROXY_URL =
  process.env.OLLAMA_THINKING_PROXY_URL ||
  `http://${OLLAMA_THINKING_PROXY_HOST}:${process.env.OLLAMA_THINKING_PROXY_PORT || 8788}`;

/** In-stack daemon default; a remote/cloud provider overrides it via
 *  provider.envVars.ANTHROPIC_BASE_URL (a remote host, or https://ollama.com). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://ollama:11434';

/** Ollama Cloud, which serves an Anthropic-compatible /v1/messages API. Cloud models
 *  (isOllamaCloudModel) route here by default — they never run on the local daemon. */
export const OLLAMA_CLOUD_URL = 'https://ollama.com';

/** The base URL an Ollama invocation should use. THE single place that decision is
 *  made, so the adapter and the Test-connection probe cannot disagree about which
 *  endpoint is actually in play — a probe that tested a different URL than the run
 *  uses would report on something nobody executes (same rule as
 *  resolveOpenRouterBaseUrl).
 *
 *  An explicitly configured URL always wins, including an empty one: that is what
 *  the adapter's `??` already did, and a provider that blanks the field is asking
 *  for the binary's own default, not for ours. */
export function resolveOllamaBaseUrl(
  env: Record<string, string | undefined>,
  opts: { model: string; disableThinking: boolean },
): string {
  if (env.ANTHROPIC_BASE_URL != null) return env.ANTHROPIC_BASE_URL;
  if (!isOllamaCloudModel(opts.model)) return OLLAMA_DEFAULT_BASE_URL;
  // "Disable model thinking" on a cloud model routes through the sidecar, which
  // injects thinking:{type:"disabled"} and forwards to ollama.com.
  return opts.disableThinking ? OLLAMA_THINKING_PROXY_URL : OLLAMA_CLOUD_URL;
}
