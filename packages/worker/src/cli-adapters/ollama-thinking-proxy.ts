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
