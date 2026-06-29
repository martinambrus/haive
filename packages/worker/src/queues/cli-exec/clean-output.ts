/* ------------------------------------------------------------------ */
/* Clean-tab output guard                                              */
/* ------------------------------------------------------------------ */
/* cli_invocations.raw_output is the terminal viewer's Clean-tab replay
 * source (StepTerminal -> staticCleanOutput). It must hold the model's
 * prose, never CLI machine protocol (stream-json / codex-jsonl NDJSON,
 * or a structured JSON wrapper). The runtime success paths already store
 * extracted prose; this guard covers the FALLBACK paths (no-result,
 * extraction failure) so a killed/timed-out/unparsed run never dumps raw
 * protocol into Clean. The full raw stream is always preserved in
 * streamLog (the Raw tab), so emptying raw_output loses nothing. */

// stream-json / JSONL event `type` values emitted by the claude-family
// (claude-code / zai / amp / ollama) and codex CLIs. Used to tell a machine
// event stream apart from prose. Kept permissive; detection also requires
// >=2 such lines (or a known init event) so a single JSON object — e.g. a
// model that legitimately answered in JSON — is NOT treated as protocol.
const CLI_PROTOCOL_EVENT_TYPES = new Set<string>([
  // claude-stream-json
  'system',
  'assistant',
  'user',
  'result',
  'rate_limit_event',
  // codex-jsonl
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

/** True when `raw` is a CLI machine-protocol stream (NDJSON of typed events),
 *  not human prose. Recognises the claude init event and the codex init event
 *  outright, otherwise requires the first non-blank line to be a typed event
 *  and at least two typed event lines overall — so a lone JSON object answer is
 *  not mistaken for protocol. */
export function looksLikeCliProtocol(raw: string): boolean {
  const head = raw.trimStart();
  if (
    head.startsWith('{"type":"system","subtype":"init"') || // claude-stream-json init
    head.startsWith('{"type":"thread.started"') // codex-jsonl init
  ) {
    return true;
  }
  const lines = raw.split('\n');
  let events = 0;
  let firstIsEvent: boolean | null = null;
  for (let i = 0; i < lines.length && i < 50; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    let ok = false;
    try {
      const o = JSON.parse(t) as { type?: unknown };
      ok = typeof o.type === 'string' && CLI_PROTOCOL_EVENT_TYPES.has(o.type);
    } catch {
      ok = false;
    }
    if (firstIsEvent === null) firstIsEvent = ok;
    if (ok) events += 1;
    if (events >= 2 && firstIsEvent) return true;
  }
  return false;
}

/** True when `raw` parses as a JSON object or array (a structured envelope such
 *  as gemini's `{response, stats}`), as opposed to plain text. Used to keep a
 *  failed-extraction JSON wrapper out of Clean while still preserving plain text
 *  emitted by an older binary that ignored its JSON-output flag. */
export function looksLikeJson(raw: string): boolean {
  const t = raw.trim();
  if (t.length === 0) return false;
  if (t[0] !== '{' && t[0] !== '[') return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** The value to persist as cli_invocations.raw_output (the Clean-tab source) for
 *  a fallback branch. Prefer the extracted model prose; otherwise fall back to
 *  the raw output ONLY when it is not CLI machine protocol, else empty string
 *  (Clean then shows "No model text for this run."). The raw stream is always
 *  kept in streamLog. */
export function proseForClean(prose: string | null | undefined, rawFallback: string): string {
  if (prose && prose.trim().length > 0) return prose;
  return looksLikeCliProtocol(rawFallback) ? '' : rawFallback;
}
