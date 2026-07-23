import type { CliTokenUsage } from '@haive/shared';

/** Pure token-usage extraction helpers shared by the cli-exec stream
 *  collectors (queues/cli-exec) and the sequential sub-agent runner. Token
 *  semantics are provider-native — see the CliTokenUsage doc in @haive/shared. */

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function sumTokenUsage(
  a: CliTokenUsage | null,
  b: CliTokenUsage | null,
): CliTokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  const out: CliTokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  if (cacheRead > 0) out.cacheReadTokens = cacheRead;
  const cacheCreation = (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0);
  if (cacheCreation > 0) out.cacheCreationTokens = cacheCreation;
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  if (cost > 0) out.costUsd = cost;
  return out;
}

/** Anthropic-style usage object (claude-code / zai result + assistant events,
 *  amp assistant events): { input_tokens, output_tokens,
 *  cache_read_input_tokens?, cache_creation_input_tokens? }. inputTokens
 *  excludes the cache fields (raw API semantics); totalTokens adds all four. */
export function normalizeClaudeUsage(raw: unknown): CliTokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheCreation = num(u.cache_creation_input_tokens) ?? 0;
  const usage: CliTokenUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: (input ?? 0) + (output ?? 0) + cacheRead + cacheCreation,
  };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheCreation > 0) usage.cacheCreationTokens = cacheCreation;
  return usage;
}

/** Codex turn.completed usage: { input_tokens, cached_input_tokens?,
 *  output_tokens }. input_tokens INCLUDES cached (OpenAI semantics);
 *  cacheReadTokens mirrors cached_input_tokens for observability. */
export function tokenUsageFromCodexUsage(raw: unknown): CliTokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  const usage: CliTokenUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: (input ?? 0) + (output ?? 0),
  };
  const cached = num(u.cached_input_tokens) ?? 0;
  if (cached > 0) usage.cacheReadTokens = cached;
  return usage;
}

export interface ExtractedGeminiOutput {
  responseText: string;
  tokenUsage: CliTokenUsage | null;
}

/** Parse `gemini --output-format json` stdout: one JSON document
 *  { response: string, stats?: { models: { <model>: { tokens: { prompt,
 *  candidates, total, cached, thoughts, tool } } } } }. Returns null when
 *  stdout is not that envelope so the caller can fall back to today's
 *  plain-text behavior (older binary, ignored flag, crash output).
 *  thoughts count toward outputTokens — they are billed model output, which
 *  keeps gemini comparable with claude (whose output includes thinking). */
export function extractGeminiJsonOutput(stdout: string): ExtractedGeminiOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.response !== 'string') return null;

  let tokenUsage: CliTokenUsage | null = null;
  const stats = doc.stats as Record<string, unknown> | undefined;
  const models =
    stats && typeof stats === 'object' ? (stats.models as Record<string, unknown>) : undefined;
  if (models && typeof models === 'object') {
    for (const entry of Object.values(models)) {
      const tokens = (entry as Record<string, unknown> | null)?.tokens as
        Record<string, unknown> | undefined;
      if (!tokens || typeof tokens !== 'object') continue;
      const prompt = num(tokens.prompt) ?? 0;
      const candidates = num(tokens.candidates) ?? 0;
      const thoughts = num(tokens.thoughts) ?? 0;
      const cached = num(tokens.cached) ?? 0;
      const total = num(tokens.total) ?? prompt + candidates + thoughts;
      const modelUsage: CliTokenUsage = {
        inputTokens: prompt,
        outputTokens: candidates + thoughts,
        totalTokens: total,
      };
      if (cached > 0) modelUsage.cacheReadTokens = cached;
      tokenUsage = sumTokenUsage(tokenUsage, modelUsage);
    }
  }
  return { responseText: doc.response, tokenUsage };
}
