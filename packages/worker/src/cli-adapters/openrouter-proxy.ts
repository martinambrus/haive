/** Address of the in-stack `openrouter-compat-proxy` sidecar (docker-compose
 *  service of the same name). Every OpenRouter invocation is pointed here instead
 *  of openrouter.ai; the proxy hoists the trailing `role:"system"` message the
 *  claude binary appends into the top-level `system` field and forwards on.
 *
 *  Unconditional rather than toggled, unlike ollama's thinking proxy: the rewrite
 *  is a no-op for requests that carry no in-array system message, and it was
 *  verified to leave already-working models (anthropic/claude-haiku-4.5,
 *  qwen/qwen3.8-max) behaving identically — so there is no case where routing
 *  through it is worse, and a per-model toggle would just be a setting users have
 *  to discover after a confusing failure. A provider that sets ANTHROPIC_BASE_URL
 *  by hand still wins, which is the escape hatch if the sidecar is ever a problem.
 *
 *  The sandbox runner exempts the host from the egress (squid) proxy so the claude
 *  binary reaches it directly over haive-sandbox.
 *
 *  Dependency-free so both cli-adapters (openrouter.ts) and sandbox
 *  (sandbox-runner.ts) can import it without pulling adapter internals. */
export const OPENROUTER_COMPAT_PROXY_HOST =
  process.env.OPENROUTER_COMPAT_PROXY_HOST || 'openrouter-compat-proxy';

export const OPENROUTER_COMPAT_PROXY_URL =
  process.env.OPENROUTER_COMPAT_PROXY_URL ||
  `http://${OPENROUTER_COMPAT_PROXY_HOST}:${process.env.OPENROUTER_COMPAT_PROXY_PORT || 8789}`;

/** OpenRouter's real endpoint. Used as the proxy's upstream and as the fallback
 *  for anything that must talk to the gateway directly. */
export const OPENROUTER_DIRECT_BASE_URL = 'https://openrouter.ai/api';

/** The base URL an OpenRouter invocation should use: an explicitly configured one
 *  wins, otherwise the compat proxy. THE single place that decision is made, so the
 *  adapter and the Test-connection probe cannot disagree about which endpoint is
 *  actually in play — a probe that tested a different URL than the run uses would
 *  report on something nobody executes. */
export function resolveOpenRouterBaseUrl(env: Record<string, string | undefined>): string {
  return env.ANTHROPIC_BASE_URL ?? OPENROUTER_COMPAT_PROXY_URL;
}
