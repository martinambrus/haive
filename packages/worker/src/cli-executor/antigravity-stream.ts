import type { CliTokenUsage } from '@haive/shared';

/* ------------------------------------------------------------------ */
/* NDJSON parser for `agy --output-format stream-json`                 */
/* ------------------------------------------------------------------ */
/* Events, as MEASURED against the shipped binary with a live call:
 *   init        { conversation_id, init: { cwd, tools, permission_mode } }
 *   step_update { step_update: { step_index, step_type, state, text_delta?, usage? } }
 *   result      { result: { status: 'SUCCESS'|'ERROR', response, error?,
 *                           num_turns, duration_seconds, usage } }
 *
 * The final answer is `result.response`; `step_update.text_delta` carries it
 * incrementally for live display.
 *
 * `init` names no model, which is why antigravity's model identity still comes
 * from its --log-file rather than from this stream.
 *
 * Lives in cli-executor (no deps) so exec-core and the sequential sub-agent
 * runner can both import it without a layering cycle — same reason as
 * codex-jsonl.ts beside it. */

export interface AntigravityStreamCollector {
  onChunk: (chunk: string) => void;
  /** `result.response`, or null when no result event arrived. */
  getResult: () => string | null;
  /** Whether any valid event was seen (vs the plain-text output of an older
   *  binary that ignored the flag). */
  isJsonl: () => boolean;
  getTokenUsage: () => CliTokenUsage | null;
  /** Why there is no usable answer: the result's own error, or a generic
   *  premature-end. Null when a result exists. */
  getNoResultReason: () => string | null;
  getMalformedLineCount: () => number;
  getEventCount: () => number;
}

/** `input + output = total` in every observed run, and `thinking_tokens` is a
 *  SUBSET of output (61 output of which 60 thinking), so adding it would double
 *  count the reasoning. */
function usageFrom(raw: unknown): CliTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const total = num(u.total_tokens);
  if (inputTokens === 0 && outputTokens === 0 && total === 0) return null;
  const cacheReadTokens = num(u.cache_read_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: total || inputTokens + outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  };
}

export function createAntigravityStreamCollector(
  onText?: (text: string) => void,
): AntigravityStreamCollector {
  let buffer = '';
  let eventCount = 0;
  let malformedLineCount = 0;
  let response: string | null = null;
  let usage: CliTokenUsage | null = null;
  let errorText: string | null = null;

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      malformedLineCount++;
      return;
    }
    if (typeof event.event !== 'string') return;
    eventCount++;

    if (event.event === 'step_update') {
      const step = event.step_update as Record<string, unknown> | undefined;
      if (step && typeof step.text_delta === 'string' && step.text_delta.length > 0) {
        onText?.(step.text_delta);
      }
      // A step's usage is superseded by the result's own total, so it is read
      // only as a running figure while the run is still going.
      if (step && !response) usage = usageFrom(step.usage) ?? usage;
      return;
    }

    if (event.event === 'result') {
      const r = event.result as Record<string, unknown> | undefined;
      if (!r) return;
      usage = usageFrom(r.usage) ?? usage;
      // ERROR with an empty response is how agy reports a refusal it exits 0
      // for — the case its --log-file capture exists to catch. Here it is a
      // field, so it needs no log parsing.
      if (typeof r.error === 'string' && r.error.length > 0) errorText = r.error;
      if (typeof r.response === 'string' && r.response.length > 0) response = r.response;
      else if (r.status === 'ERROR' && !errorText) errorText = 'antigravity reported ERROR';
    }
  }

  return {
    onChunk(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    },
    getResult: () => response,
    isJsonl: () => eventCount > 0,
    getEventCount: () => eventCount,
    getTokenUsage: () => usage,
    getNoResultReason: () =>
      response
        ? null
        : (errorText ??
          'antigravity stream ended without a result event (likely timeout or an aborted session)'),
    getMalformedLineCount: () => malformedLineCount,
  };
}

/** One-shot form for the sequential sub-agent runner, which has the whole
 *  stdout in hand rather than a stream. Same parser, so the two paths cannot
 *  disagree about what a run returned. */
export function extractAntigravityStreamOutput(stdout: string): {
  eventCount: number;
  text: string | null;
  tokenUsage: CliTokenUsage | null;
} {
  const collector = createAntigravityStreamCollector();
  collector.onChunk(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  return {
    eventCount: collector.getEventCount(),
    text: collector.getResult(),
    tokenUsage: collector.getTokenUsage(),
  };
}
