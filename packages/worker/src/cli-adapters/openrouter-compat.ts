/**
 * Pre-flight check for "this OpenRouter model cannot run a Haive step", run from
 * the provider's Test-connection probe so an incompatible model is caught at save
 * time rather than on the first real task.
 *
 * WHY THIS EXISTS. The claude binary appends a `role: "system"` message to the END
 * of `messages` (it carries the Agent tool's agent-type listing) on top of the
 * top-level `system` field. For an Anthropic model OpenRouter passes the request
 * through natively and that is fine. For every other vendor it must translate the
 * Anthropic wire format to the OpenAI one, and the trailing system message keeps
 * its position — which vLLM-style backends reject outright:
 *
 *   400 "System message must be at the beginning."
 *
 * MEASURED on qwen/qwen3.8-27b: all three of its upstream providers (Chutes, Io
 * Net, AkashML) returned that error, so it is a property of the MODEL's backends,
 * not of provider routing, and no retry or fallback escapes it. The same request
 * against qwen/qwen3.8-max, openai/gpt-5.6, x-ai/grok-4.6 and anthropic/* succeeds.
 *
 * The catalog cannot predict this: the failing model advertises `tools` in its
 * `supported_parameters`, so the picker's tool-support filter passes it. Only an
 * actual request finds it, which is what this does.
 *
 * It is also the ONLY place the real reason is visible. Through the CLI the failure
 * arrives as the binary's opaque "API Error: 400 Provider returned error"; the
 * upstream detail lives in OpenRouter's `metadata.raw`, which the binary discards.
 * Calling the endpoint directly is what lets us show the user the actual sentence.
 */

const PROBE_TIMEOUT_MS = 20_000;

export interface OpenRouterCompatResult {
  /** False only when the model DEFINITIVELY rejected the request shape. Anything
   *  inconclusive (network error, auth failure, rate limit) reports true: this is
   *  an advisory, and blocking a provider on a transient blip would be worse than
   *  missing an incompatible model. */
  compatible: boolean;
  /** Upstream's own sentence, when we managed to dig one out. */
  detail?: string;
}

/** Dig the upstream provider's human-readable sentence out of OpenRouter's error.
 *
 *  The body nests JSON inside JSON strings (OpenRouter wraps whatever the upstream
 *  sent), and the nesting depth varies by provider — Chutes double-wraps, AkashML
 *  single-wraps. Rather than model each shape, walk the parsed structure for the
 *  deepest `message`/`detail` string. Returns null rather than throwing on anything
 *  unexpected: a missing detail must degrade to a generic warning, never an error. */
export function extractOpenRouterErrorDetail(body: unknown): string | null {
  const seen = new Set<unknown>();
  let best: { text: string; depth: number } | null = null;

  /** Parse JSON that may be EMBEDDED after a prefix, e.g.
   *  `Invalid request: Invalid request: {"detail":{…}}`. Chutes prefixes its
   *  wrapped payload like this, so anchoring on `startsWith('{')` misses it and
   *  the user gets the braces instead of the sentence. */
  const parseEmbedded = (text: string): unknown => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  };

  const consider = (text: string, depth: number): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const embedded = parseEmbedded(trimmed);
    if (embedded !== undefined) {
      // Keep descending: the braces are a wrapper, not the answer.
      walk(embedded, depth + 1);
      return;
    }
    // DEEPEST wins, not longest. Every wrapper layer restates the failure more
    // vaguely than the one it wraps — the outermost is always the useless
    // "Provider returned error", and the innermost is the upstream's real sentence.
    if (!best || depth > best.depth) best = { text: trimmed, depth };
  };

  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      const embedded = parseEmbedded(node);
      if (embedded !== undefined) walk(embedded, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ['message', 'detail']) {
      const value = obj[key];
      if (typeof value === 'string') consider(value, depth);
    }
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };

  walk(body, 0);
  return best ? (best as { text: string }).text : null;
}

/** Send one minimal request shaped like the claude binary's — a tool plus a
 *  TRAILING system message — and report whether the model's backend accepts it.
 *
 *  `max_tokens: 1` keeps a passing probe to a fraction of a cent; a failing one is
 *  rejected before inference and costs nothing. */
export async function probeOpenRouterModelCompat(opts: {
  baseUrl: string;
  token: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenRouterCompatResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    model: opts.model,
    max_tokens: 1,
    system: 'probe',
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    messages: [
      { role: 'user', content: 'hi' },
      // The whole point of the probe. Mirrors what the binary appends.
      { role: 'system', content: [{ type: 'text', text: 'Available agent types...' }] },
    ],
  };

  let resp: Response;
  try {
    resp = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // Unreachable / timed out — inconclusive, never a verdict.
    return { compatible: true };
  }

  if (resp.ok) return { compatible: true };
  // 401/403/429 say something about the KEY or the quota, not the model shape.
  if (resp.status !== 400) return { compatible: true };

  let parsed: unknown = null;
  try {
    parsed = await resp.json();
  } catch {
    return { compatible: false };
  }
  const detail = extractOpenRouterErrorDetail(parsed);
  return detail ? { compatible: false, detail } : { compatible: false };
}
