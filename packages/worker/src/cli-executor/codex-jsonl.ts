import type { CliTokenUsage } from '@haive/shared';
import { sumTokenUsage, tokenUsageFromCodexUsage } from './usage-extract.js';

/* ------------------------------------------------------------------ */
/* JSONL parser for `codex exec --json`                                */
/* ------------------------------------------------------------------ */
/* Events: thread.started, turn.started, item.* (item.completed with
 * item.type 'agent_message' carries the assistant's text), turn.completed
 * (usage {input_tokens, cached_input_tokens, output_tokens}), turn.failed,
 * error. The final answer = the LAST agent_message; multi-turn usage sums.
 * Lives in cli-executor (no deps) so both exec-core (queues/cli-exec) and
 * the sequential sub-agent runner can import it without a layering cycle. */

export interface CodexJsonlCollector {
  /** Feed raw stdout chunks; parses complete JSONL lines. */
  onChunk: (chunk: string) => void;
  /** Text of the last completed agent_message, or null. */
  getResult: () => string | null;
  /** Whether any valid codex JSONL event was seen (vs plain text output). */
  isJsonl: () => boolean;
  /** Summed usage across turn.completed events, or null. */
  getTokenUsage: () => CliTokenUsage | null;
  /** Failure reason from turn.failed / error events, else a generic
   *  premature-end message. Null when a result exists. */
  getNoResultReason: () => string | null;
  getMalformedLineCount: () => number;
}

export function createCodexJsonlCollector(onText?: (text: string) => void): CodexJsonlCollector {
  let buffer = '';
  let eventCount = 0;
  let malformedLineCount = 0;
  let lastAgentMessage: string | null = null;
  let usageSum: CliTokenUsage | null = null;
  let lastError: string | null = null;

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

    const type = event.type;
    if (type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        lastAgentMessage = item.text;
        onText?.(item.text);
      }
      return;
    }
    if (type === 'turn.completed') {
      usageSum = sumTokenUsage(usageSum, tokenUsageFromCodexUsage(event.usage));
      return;
    }
    if (type === 'turn.failed') {
      const err = event.error as Record<string, unknown> | undefined;
      if (typeof err?.message === 'string') lastError = err.message;
      return;
    }
    if (type === 'error' && typeof event.message === 'string') {
      lastError = event.message;
    }
  }

  function flush(): void {
    if (buffer.trim()) {
      processLine(buffer);
      buffer = '';
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
      flush();
      return lastAgentMessage;
    },
    isJsonl(): boolean {
      flush();
      return eventCount > 0;
    },
    getTokenUsage(): CliTokenUsage | null {
      flush();
      return usageSum;
    },
    getNoResultReason(): string | null {
      flush();
      if (lastAgentMessage !== null) return null;
      if (eventCount === 0) return null;
      if (lastError) return `codex turn failed: ${lastError}`;
      return 'codex emitted no agent_message (stream ended prematurely — likely timeout or abort)';
    },
    getMalformedLineCount(): number {
      return malformedLineCount;
    },
  };
}

export interface ExtractedCodexOutput {
  text: string | null;
  tokenUsage: CliTokenUsage | null;
  eventCount: number;
}

/** Full-buffer JSONL extraction for the sequential sub-agent runner: feeds
 *  the collector once. eventCount === 0 means the stdout was not codex JSONL
 *  (older binary ignoring --json) — callers fall back to raw stdout. */
export function extractCodexJsonlOutput(stdout: string): ExtractedCodexOutput {
  const collector = createCodexJsonlCollector();
  collector.onChunk(stdout);
  const text = collector.getResult();
  return {
    text,
    tokenUsage: collector.getTokenUsage(),
    eventCount: collector.isJsonl() ? 1 : 0,
  };
}
