/* ------------------------------------------------------------------ */
/* NDJSON stream-json parser for Claude Code / Zai / Amp               */
/* ------------------------------------------------------------------ */

import type { CliTokenUsage } from '@haive/shared';
import { normalizeClaudeUsage } from '../../cli-executor/usage-extract.js';

interface StreamJsonCollector {
  /** Feed raw stdout chunks. Parses NDJSON lines, emits progress, collects result. */
  onChunk: (chunk: string) => void;
  /** Final result text extracted from the result/success event, or null. */
  getResult: () => string | null;
  /** Whether the stream contained valid NDJSON events (vs plain JSON output). */
  isStreamJson: () => boolean;
  /** Human-readable reason when the stream ended without a success result. */
  getNoResultReason: () => string | null;
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
}

export function createStreamJsonCollector(
  onProgress?: (message: string) => void,
): StreamJsonCollector {
  let buffer = '';
  let resultText: string | null = null;
  let eventCount = 0;
  let malformedLineCount = 0;
  let assistantText = '';
  let lastResultSubtype: string | null = null;
  let lastResultError: string | null = null;
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
  let costUsd: number | null = null;
  let lastRateLimit: {
    status?: string;
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

    // Extract final result
    if (type === 'result') {
      if (typeof subtype === 'string') lastResultSubtype = subtype;
      // Usage rides the result event on ANY subtype (an error_max_turns run
      // still burned tokens) — capture before the success early-return.
      const usage = normalizeClaudeUsage(event.usage);
      if (usage) resultUsage = usage;
      if (typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)) {
        costUsd = event.total_cost_usd;
      }
      // Some CLIs (e.g. amp) put a human-readable failure reason on the result
      // event's `error` field — surface it instead of the bare subtype.
      if (typeof event.error === 'string' && event.error.trim()) {
        lastResultError = event.error.trim();
      }
      if (subtype === 'success' && typeof event.result === 'string') {
        resultText = event.result;
        return;
      }
    }

    // Always collect assistant text deltas — used as a cross-check against the
    // result event when downstream parsing fails.
    if (type === 'assistant') {
      const msg = event.message as Record<string, unknown> | undefined;
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
          } else if (b.type === 'tool_use' && onProgress) {
            const toolName = b.name as string;
            const input = b.input as Record<string, unknown> | undefined;
            const desc = describeToolUse(toolName, input);
            if (desc) onProgress(desc);
          }
        }
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
        const base = `LLM stream ended with result subtype "${lastResultSubtype}"`;
        return lastResultError ? `${base}: ${lastResultError}` : base;
      }
      if (lastRateLimit?.overageStatus === 'rejected' && lastRateLimit.isUsingOverage) {
        return `LLM blocked by rate limit (${lastRateLimit.overageDisabledReason ?? 'overage rejected'})`;
      }
      return 'LLM emitted no result event (stream ended prematurely — likely timeout, session abort, or quota rejection)';
    },
    getAssistantText(): string {
      return assistantText;
    },
    getMalformedLineCount(): number {
      return malformedLineCount;
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
