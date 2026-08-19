/* ------------------------------------------------------------------ */
/* NDJSON stream-json parser for Claude Code / Zai / Amp               */
/* ------------------------------------------------------------------ */

import type { CliTokenUsage } from '@haive/shared';
import { normalizeClaudeUsage } from '../../cli-executor/usage-extract.js';
import { classifyStreamFailure, OUTPUT_TRUNCATION_HEADLINE } from './failure-class.js';
import { isPlaceholderModel, type StreamModelReport } from './model-identity.js';

interface StreamJsonCollector {
  /** Feed raw stdout chunks. Parses NDJSON lines, emits progress, collects result. */
  onChunk: (chunk: string) => void;
  /** Final result text extracted from the result/success event, or null. */
  getResult: () => string | null;
  /** Whether the stream contained valid NDJSON events (vs plain JSON output). */
  isStreamJson: () => boolean;
  /** Human-readable reason when the stream ended without a success result. */
  getNoResultReason: () => string | null;
  /** True when the result event set the run-level `is_error` flag. Lets the caller
   *  prefer getNoResultReason() (the binary's own error text) over the stdout tail,
   *  which for a stream-json CLI is raw NDJSON. */
  hadResultError: () => boolean;
  /** Concatenation of every text block from assistant events. Lets us cross-check
   *  the result event's payload against the deltas claude-code actually streamed. */
  getAssistantText: () => string;
  /** Count of stream-json lines that failed JSON.parse — non-zero means the
   *  stream got mangled (chunk corruption, partial flush, mixed protocol). */
  getMalformedLineCount: () => number;
  /** Token usage: the result event's usage when present (claude/zai — wins,
   *  never summed with assistant usages), else the sum of assistant-event
   *  usages (amp emits no result usage). Null when nothing reported. */
  getTokenUsage: () => CliTokenUsage | null;
  /** Which model this stream ASKED for vs which one ANSWERED. Two distinct
   *  channels — see StreamModelReport / model-identity.ts. Null when the stream
   *  named no model anywhere (amp's init reports `agent_mode` instead). */
  getModelIdentity: () => StreamModelReport | null;
}

export function createStreamJsonCollector(
  onProgress?: (message: string) => void,
  onText?: (text: string) => void,
  /** Fired once, the first time a `result` event is parsed, regardless of
   *  subtype (success OR error_max_turns / context overflow / etc). The
   *  steering forwarder latches on this to close stdin so the CLI exits after
   *  its turn — keying on getResult()!==null would miss non-success results and
   *  hang until the SIGKILL timeout. */
  onResult?: () => void,
  /** Fired once per parsed `user` event that carries a `tool_result` block — the
   *  observable tool-call boundary at which Claude drains any stdin-queued steer
   *  messages. The steering tracker uses this to mark pending steers consumed. */
  onBoundary?: () => void,
): StreamJsonCollector {
  let buffer = '';
  let resultText: string | null = null;
  let resultFired = false;
  let eventCount = 0;
  let malformedLineCount = 0;
  let assistantText = '';
  let lastResultSubtype: string | null = null;
  let lastResultError: string | null = null;
  // Run-level failure reported by the result event's `is_error` flag, plus the
  // text and terminal_reason that came with it. Tracked separately from
  // lastResultSubtype because the two disagree: a mid-stream API abort is
  // subtype "success" with is_error true (see the result handler).
  let resultIsError = false;
  let resultErrorText: string | null = null;
  let resultTerminalReason: string | null = null;
  let resultUsage: CliTokenUsage | null = null;
  // Live fallback (mid-stream snapshots, before the authoritative `result` event
  // arrives): sum fresh input/output across assistant turns. Cache is asymmetric:
  // each Anthropic turn re-reports the FULL cached prefix it read, so cache_read
  // is taken as the running MAX (summing it inflates the live total several-fold);
  // cache_creation is a distinct one-time write per turn, so it is summed.
  let assistantInputSum = 0;
  let assistantOutputSum = 0;
  let assistantCacheReadMax = 0;
  let assistantCacheCreationSum = 0;
  let sawAssistantUsage = false;
  // Model identity. `requestedModel` comes from the init event (what the binary
  // asked for) and `servedModel` from the assistant events (what the endpoint
  // returned) — they are NOT the same value and can disagree, which is the entire
  // reason both are tracked. servedModel keeps the LAST non-placeholder value, so a
  // run whose final turn is a CLI-authored `<synthetic>` error still reports the
  // real model from the turns that did come back.
  let requestedModel: string | null = null;
  let servedModel: string | null = null;
  const billedModels = new Set<string>();
  let costUsd: number | null = null;
  let lastRateLimit: {
    status?: string;
    /** Which window was exhausted, e.g. "five_hour". Names the limit in the message. */
    rateLimitType?: string;
    /** Unix SECONDS (not ms) — the provider sends epoch seconds. */
    resetsAt?: number;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  } | null = null;

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
    if (typeof event.type !== 'string') return;
    eventCount++;

    const type = event.type as string;
    const subtype = event.subtype as string | undefined;

    if (type === 'rate_limit_event') {
      const info = event.rate_limit_info as typeof lastRateLimit;
      if (info) lastRateLimit = info;
    }

    // The init event names the model the binary resolved from its own config/env.
    // First one wins: a session emits exactly one, and a later one would be a new
    // session rather than a correction.
    if (type === 'system' && subtype === 'init' && requestedModel === null) {
      if (typeof event.model === 'string' && event.model.trim()) {
        requestedModel = event.model.trim();
      }
    }

    // Extract final result
    if (type === 'result') {
      if (!resultFired) {
        resultFired = true;
        onResult?.();
      }
      if (typeof subtype === 'string') lastResultSubtype = subtype;
      // Usage rides the result event on ANY subtype (an error_max_turns run
      // still burned tokens) — capture before the success early-return.
      const usage = normalizeClaudeUsage(event.usage);
      if (usage) resultUsage = usage;
      if (typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)) {
        costUsd = event.total_cost_usd;
      }
      // modelUsage is keyed by model and lists EVERY model billed for the run,
      // including side calls the CLI makes on its own (claude-code bills a haiku
      // call for session titling). Recorded for visibility only — it is not an
      // identity source: grok bills under `grok-4.6-build` while serving `grok-4.6`.
      const modelUsage = event.modelUsage as Record<string, unknown> | undefined;
      if (modelUsage && typeof modelUsage === 'object') {
        for (const key of Object.keys(modelUsage)) {
          if (key.trim() && !isPlaceholderModel(key)) billedModels.add(key.trim());
        }
      }
      // Some CLIs (e.g. amp) put a human-readable failure reason on the result
      // event's `error` field — surface it instead of the bare subtype.
      if (typeof event.error === 'string' && event.error.trim()) {
        lastResultError = event.error.trim();
      }
      // `is_error` is the RUN-LEVEL outcome flag and is the authoritative failure
      // signal; `subtype` is not. The claude binary reports a mid-stream API abort
      // as subtype "success" WITH is_error true, putting the error text in `result`.
      // MEASURED against ollama.com stalling mid-response:
      //   {"subtype":"success","is_error":true,"terminal_reason":"api_error",
      //    "result":"API Error: The response stopped arriving. ..."}
      // Keying the success branch on subtype alone stored that error string as the
      // model's ANSWER (and, on the exit-0 variant, fed it to the step's parser as a
      // real reply) while dropping providerErrorScan, blinding classifyProviderFatal.
      //
      // Read ONLY from the `result` event: `is_error` also appears on tool_result
      // blocks inside `user` events, where it means one tool call failed and says
      // nothing about the run — a successful claude-code run legitimately carries
      // several of those (verified on f5933ed9, is_error:false at the result event).
      if (event.is_error === true) resultIsError = true;
      if (typeof event.terminal_reason === 'string' && event.terminal_reason.trim()) {
        resultTerminalReason = event.terminal_reason.trim();
      }
      // On a failed run `result` holds the error text, not an answer — keep it for
      // the reason message rather than letting it become the result payload.
      if (resultIsError && typeof event.result === 'string' && event.result.trim()) {
        resultErrorText = event.result.trim();
      }
      if (subtype === 'success' && !resultIsError && typeof event.result === 'string') {
        resultText = event.result;
        return;
      }
    }

    // Always collect assistant text deltas — used as a cross-check against the
    // result event when downstream parsing fails.
    if (type === 'assistant') {
      const msg = event.message as Record<string, unknown> | undefined;
      // What actually answered. Placeholders are skipped: claude-code emits
      // model:"<synthetic>" with zero usage for messages IT authored (e.g. an API
      // error), and taking that would report "<synthetic>" as the model of every
      // failed run — measured on an OpenRouter 402.
      if (typeof msg?.model === 'string' && msg.model.trim() && !isPlaceholderModel(msg.model)) {
        servedModel = msg.model.trim();
      }
      // Amp's usage placement is undocumented — accept both message.usage and
      // a top-level usage, preferring message.usage, counted ONCE per event.
      const usage = normalizeClaudeUsage(msg?.usage ?? event.usage);
      if (usage) {
        sawAssistantUsage = true;
        assistantInputSum += usage.inputTokens;
        assistantOutputSum += usage.outputTokens;
        assistantCacheReadMax = Math.max(assistantCacheReadMax, usage.cacheReadTokens ?? 0);
        assistantCacheCreationSum += usage.cacheCreationTokens ?? 0;
      }
      const content = msg?.content as unknown[] | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            assistantText += b.text;
            onText?.(b.text);
          } else if (b.type === 'tool_use' && onProgress) {
            const toolName = b.name as string;
            const input = b.input as Record<string, unknown> | undefined;
            const desc = describeToolUse(toolName, input);
            if (desc) onProgress(desc);
          }
        }
      }
    }

    // A `user` event carrying a tool_result marks a completed tool call — the
    // boundary at which Claude merges any stdin-queued steer messages before its
    // next turn. (Injected steers are NOT echoed verbatim here, so we key on the
    // boundary, not on matching the steer text.)
    if (type === 'user' && onBoundary) {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content as unknown[] | undefined;
      if (
        Array.isArray(content) &&
        content.some((b) => (b as Record<string, unknown> | null)?.type === 'tool_result')
      ) {
        onBoundary();
      }
    }
  }

  return {
    onChunk(chunk: string): void {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
      }
    },
    getResult(): string | null {
      // Process any remaining buffer content
      if (buffer.trim()) {
        processLine(buffer);
        buffer = '';
      }
      return resultText;
    },
    isStreamJson(): boolean {
      return eventCount > 0;
    },
    getNoResultReason(): string | null {
      if (resultText !== null) return null;
      if (eventCount === 0) return null;
      if (lastResultSubtype && lastResultSubtype !== 'success') {
        const cls = classifyStreamFailure(lastResultSubtype, lastResultError);
        const detail = lastResultError ? `: ${lastResultError}` : '';
        if (cls === 'output_truncated') {
          // The assistant hit its OUTPUT-token ceiling and the turn was cut off
          // (e.g. Amp/Claude max_tokens). The fix is to emit less per call, not to
          // retry the same oversized request — see failure-class.ts.
          return `${OUTPUT_TRUNCATION_HEADLINE} — the response was cut off at the model's output-token limit (subtype "${lastResultSubtype}"${detail}). Reduce the requested output or split the task into smaller calls.`;
        }
        if (cls === 'context_overflow') {
          return `LLM stopped: the prompt exceeded the model's context window (subtype "${lastResultSubtype}"${detail}). Reduce the prompt size or clear prior context.`;
        }
        const base = `LLM stream ended with result subtype "${lastResultSubtype}"`;
        return lastResultError ? `${base}: ${lastResultError}` : base;
      }
      // Rate limit FIRST — ahead of the is_error branch below, which would otherwise
      // claim these runs and report them as a generic failure. `rate_limit_info.status`
      // is the STRUCTURED signal that the request was refused; the provider's prose is
      // not. The old guard also required `isUsingOverage`, which only says whether the
      // account was on overage when it was refused — orthogonal to being refused at all.
      // MEASURED on the 22 rows this missed: every one carries status "rejected" and
      // NONE has isUsingOverage, so the structured path never fired and they fell
      // through to prose. "You've hit your limit" (unlike the "session limit" variant)
      // matches no RATE_LIMIT_RE alternative, so they ended up unclassified — no
      // rate-limit headline, no provider-outage watch, just a bare CLI failure.
      // The message keeps a literal "rate limit" so classifyProviderFatal still matches.
      if (lastRateLimit?.status === 'rejected') {
        const kind = lastRateLimit.rateLimitType ? `${lastRateLimit.rateLimitType}, ` : '';
        const resets = lastRateLimit.resetsAt
          ? `resets ${new Date(lastRateLimit.resetsAt * 1000).toISOString()}`
          : (lastRateLimit.overageDisabledReason ?? 'no reset time reported');
        return `LLM blocked by rate limit (${kind}${resets})`;
      }
      if (lastRateLimit?.overageStatus === 'rejected' && lastRateLimit.isUsingOverage) {
        return `LLM blocked by rate limit (${lastRateLimit.overageDisabledReason ?? 'overage rejected'})`;
      }
      // Result event flagged is_error while carrying a "success" subtype (the
      // mid-stream API abort above). Report the binary's own error text: it is far
      // more specific than the generic fallback below, and — load-bearing — that
      // fallback's "stream ended prematurely" wording matches
      // TRANSIENT_CLI_FAILURE_RE, which would misread a provider error as a
      // killed-run and silently re-dispatch it.
      if (resultIsError) {
        const detail = resultErrorText ?? lastResultError;
        const where = resultTerminalReason ? ` (terminal_reason "${resultTerminalReason}")` : '';
        const base = `LLM run reported a failure${where}`;
        return detail ? `${base}: ${detail}` : base;
      }
      return 'LLM emitted no result event (stream ended prematurely — likely timeout, session abort, or quota rejection)';
    },
    hadResultError(): boolean {
      return resultIsError;
    },
    getAssistantText(): string {
      return assistantText;
    },
    getMalformedLineCount(): number {
      return malformedLineCount;
    },
    getModelIdentity(): StreamModelReport | null {
      if (buffer.trim()) {
        processLine(buffer);
        buffer = '';
      }
      if (requestedModel === null && servedModel === null && billedModels.size === 0) return null;
      return { requested: requestedModel, served: servedModel, billed: [...billedModels] };
    },
    getTokenUsage(): CliTokenUsage | null {
      if (buffer.trim()) {
        processLine(buffer);
        buffer = '';
      }
      // The result event's usage is authoritative and already cumulative — prefer
      // it outright. Before it arrives (live snapshots), build the fallback from
      // summed input/output + the LAST turn's cache (see the accumulator note).
      let assistantUsage: CliTokenUsage | null = null;
      if (sawAssistantUsage) {
        assistantUsage = {
          inputTokens: assistantInputSum,
          outputTokens: assistantOutputSum,
          totalTokens:
            assistantInputSum +
            assistantOutputSum +
            assistantCacheReadMax +
            assistantCacheCreationSum,
        };
        if (assistantCacheReadMax > 0) assistantUsage.cacheReadTokens = assistantCacheReadMax;
        if (assistantCacheCreationSum > 0)
          assistantUsage.cacheCreationTokens = assistantCacheCreationSum;
      }
      const base = resultUsage ?? assistantUsage;
      if (!base) return null;
      return costUsd !== null ? { ...base, costUsd } : base;
    },
  };
}

function describeToolUse(name: string, input?: Record<string, unknown>): string | null {
  switch (name) {
    case 'Read':
    case 'read_file': {
      const filePath = (input?.file_path ?? input?.path) as string | undefined;
      return filePath ? `Reading ${filePath}` : `Reading file...`;
    }
    case 'Grep':
    case 'grep':
    case 'search': {
      const pattern = input?.pattern as string | undefined;
      return pattern ? `Searching for "${pattern}"` : 'Searching codebase...';
    }
    case 'Glob':
    case 'glob':
    case 'list_files': {
      const pat = input?.pattern as string | undefined;
      return pat ? `Finding files: ${pat}` : 'Finding files...';
    }
    case 'Write':
    case 'write_file':
    case 'Edit':
    case 'edit_file': {
      const filePath = (input?.file_path ?? input?.path) as string | undefined;
      return filePath ? `Editing ${filePath}` : 'Editing file...';
    }
    case 'Bash':
    case 'bash':
    case 'execute_command': {
      const cmd = input?.command as string | undefined;
      if (!cmd) return 'Running command...';
      const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      return `Running: ${short}`;
    }
    default:
      return `Using ${name}...`;
  }
}
