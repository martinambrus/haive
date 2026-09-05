/** Does this Ollama provider actually answer? — the Test-connection check.
 *
 *  `claude --version` succeeds no matter how the provider is configured, and ollama
 *  is not in WRAPPER_REQUIRED_KEY_ENVS (a local daemon legitimately needs no key), so
 *  before this the shallow branch of probeCliPath had nothing left to look at and
 *  returned green for every Ollama provider. MEASURED: a provider whose
 *  ANTHROPIC_BASE_URL pointed at http://localhost:11434 — unreachable from inside the
 *  sandbox, where localhost is the sandbox itself — tested OK and then failed every
 *  step with "API Error: Connection refused".
 *
 *  Unlike probeOpenRouterModelCompat, which stays silent on everything except a 400
 *  because it is judging one narrow thing (the request SHAPE the binary sends), this
 *  reports any answer that is not a success. Reachability, credential and model are
 *  the whole question here, and each of them is a configuration mistake the user can
 *  fix — reporting "inconclusive" as green is what produced the false all-clear. */
export interface OllamaProbeResult {
  ok: boolean;
  /** The upstream's own words (or the transport error), for the failure message. */
  detail?: string;
}

const PROBE_TIMEOUT_MS = 20_000;
const DETAIL_MAX_CHARS = 300;

/** Pull the human-readable reason out of an error body. Ollama's Anthropic layer
 *  answers `{type:"error",error:{type,message}}`, its native layer `{error:"..."}`,
 *  and a proxy in front may answer with neither — so fall back to the raw text. */
function extractDetail(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === 'string' && err.trim()) return err.trim().slice(0, DETAIL_MAX_CHARS);
      if (err && typeof err === 'object') {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) {
          return message.trim().slice(0, DETAIL_MAX_CHARS);
        }
      }
      const message = obj.message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim().slice(0, DETAIL_MAX_CHARS);
      }
    }
  } catch {
    // Not JSON — the raw text is the best detail available.
  }
  return text.slice(0, DETAIL_MAX_CHARS);
}

/** undici collapses every transport failure into the same "fetch failed", which names
 *  nothing the user can act on. The `cause` carries the real one — and its `code`
 *  (ECONNREFUSED, ENOTFOUND, ECONNRESET) is the part that distinguishes "wrong host"
 *  from "nothing listening", so it is kept even when the cause has no message, which
 *  is the common shape. */
function describeTransportError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    const obj = cause as { code?: unknown; message?: unknown };
    const code = typeof obj.code === 'string' ? obj.code : null;
    const message = typeof obj.message === 'string' && obj.message.trim() ? obj.message : null;
    const detail = [code, message].filter(Boolean).join(': ');
    if (detail) return `${err.message} (${detail})`;
  }
  return err.message;
}

/** One minimal /v1/messages request through the base URL the run will actually use.
 *
 *  `max_tokens: 1` keeps a passing probe to a fraction of a cent on Ollama Cloud and
 *  costs nothing at all on a local daemon; a failing one is rejected before inference. */
export async function probeOllamaEndpoint(opts: {
  baseUrl: string;
  token: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<OllamaProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable or timed out. Reported, not swallowed — this is the failure mode
    // the check exists for.
    return { ok: false, detail: describeTransportError(err) };
  }

  if (resp.ok) return { ok: true };
  let body = '';
  try {
    body = await resp.text();
  } catch {
    // Body unreadable; the status alone still names the failure.
  }
  const detail = extractDetail(body);
  return { ok: false, detail: detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}` };
}
