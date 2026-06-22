/**
 * Robust extraction of JSON emitted by CLI agents inside ```json fenced blocks.
 *
 * Agents wrap their JSON in a ```json fence, but a string field in that JSON can
 * carry free-form markdown or code (a spec body, a KB article, a skill body) which
 * itself contains nested ``` code fences. A non-greedy /```json([\s\S]*?)```/ stops
 * at the FIRST inner fence and truncates the JSON, so JSON.parse throws. These
 * helpers brace-match instead: they anchor on the fence then balance-scan the
 * brackets with string/escape awareness, so nested fences and any trailing prose
 * after the value are ignored. They also recover fence-less raw JSON.
 *
 * The string-returning helpers (extractFencedJson / extractFencedJsonObjects) hand
 * back STRINGS; callers run JSON.parse and their own shape guards. parseJsonLoose
 * goes one step further and returns the parsed value, with a jsonrepair salvage pass.
 */

import { jsonrepair } from 'jsonrepair';

/**
 * Index of the bracket that closes the `{` or `[` at `openIdx`, or -1 if the value
 * never closes. String- and escape-aware so brackets inside string values are
 * ignored. Tracks only the open char's bracket type; the other bracket type is
 * always balanced within a valid JSON value, so it can be skipped.
 */
export function findBalancedEnd(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract a single top-level JSON value (object OR array) from agent text. Anchors
 * on the first ```json fence (falls back to offset 0 when there is no fence), finds
 * the first `{` or `[`, and balance-matches to its partner. Returns the JSON slice,
 * or null when no balanced value is found. Immune to nested ``` fences inside string
 * values and to trailing prose after the value.
 */
export function extractFencedJson(text: string): string | null {
  const fence = /```json\s*/i.exec(text);
  const start = fence ? fence.index + fence[0].length : 0;
  let open = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const end = findBalancedEnd(text, open);
  if (end < 0) return null;
  return text.slice(open, end + 1);
}

/**
 * Extract every top-level balanced `{...}` object from agent text. Use for payloads
 * that emit several separate objects (multiple ```json blocks) or a top-level array
 * of objects that should be salvaged element by element. Each candidate starts at a
 * `{` followed by a quoted key. Returns the object slices in order.
 */
export function extractFencedJsonObjects(text: string): string[] {
  const out: string[] = [];
  const candidateRe = /\{\s*"/g;
  let cursor = 0;
  while (cursor < text.length) {
    candidateRe.lastIndex = cursor;
    const m = candidateRe.exec(text);
    if (!m) break;
    const end = findBalancedEnd(text, m.index);
    if (end < 0) break;
    out.push(text.slice(m.index, end + 1));
    cursor = end + 1;
  }
  return out;
}

/**
 * Raw slice from the first `{` or `[` (after a ```json fence when present, else from
 * offset 0) to end-of-text, with no closing-bracket requirement. This is the only
 * candidate that survives a TRUNCATED stream — output cut mid-value, so there is no
 * balanced close and no closing ``` fence — which jsonrepair can then complete.
 * Returns null when the text holds no bracket at all (pure prose).
 */
function rawJsonTail(text: string): string | null {
  const fence = /```json\s*/i.exec(text);
  const start = fence ? fence.index + fence[0].length : 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') return text.slice(i);
  }
  return null;
}

/**
 * Escape double-quotes that sit INSIDE a JSON string but were left unescaped by a
 * weak model — e.g. a literal `"` in a value (`` and `"` to `&quot;` ``). Such a
 * stray quote desyncs both the balanced scanner (findBalancedEnd) and jsonrepair,
 * which each read it as a string boundary, so the whole value fails to parse.
 *
 * A `"` is a real string boundary only when the next non-space char is structural
 * (`:` `,` `}` `]`) or end-of-input; any other `"` inside an open string is an inner
 * quote and gets `\`-escaped. Already-escaped quotes (`\"`) are skipped, so VALID
 * JSON passes through byte-for-byte unchanged (no false escapes). Best-effort: an
 * inner quote that happens to be followed by a structural char (the genuinely
 * ambiguous `he said "ok", bye` shape) is still mis-read — callers validate the
 * parsed shape downstream, so a wrong recovery is rejected, not trusted.
 *
 * Run this on the raw tail (which starts at the first bracket) so quote tracking
 * begins in sync — running it across leading prose would start mid-stream.
 */
export function escapeInnerQuotes(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      out += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) {
        j++;
      }
      const next = s[j];
      if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
        out += c;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Robust best-effort parse of a single JSON value from agent text — for strict-JSON
 * step contracts that a flaky model intermittently mangles. Tries, in order: the
 * balanced-scan slice (extractFencedJson — immune to nested ``` fences and trailing
 * prose), the greedy fence span, the lazy fence span — each first with strict
 * JSON.parse. If every strict parse fails, retries each candidate (plus the raw tail
 * for truncated streams) through jsonrepair, which closes the common weak-model
 * defects: a dropped quote/comma or an unterminated tail. Returns the parsed value,
 * or null when nothing yields JSON. Callers run their own shape validation, so a
 * repaired-but-wrong-shape result is still rejected downstream. Mirrors the salvage
 * chain in 06_5-agent-discovery and 08-knowledge-acquisition.
 */
export function parseJsonLoose(text: string): unknown | null {
  const greedy = text.match(/```(?:json)?\s*([\s\S]*)```/i);
  const lazy = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [extractFencedJson(text), greedy?.[1], lazy?.[1]].filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0,
  );
  // Strict pass: the balanced slice wins (handles nested fences / trailing prose),
  // then the fenced spans.
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // fall through to the next candidate / the salvage pass
    }
  }
  // Salvage pass: jsonrepair the same candidates, plus the raw tail (the only one
  // that survives truncation). Order keeps the cleanest candidate first.
  const repairCandidates = [...candidates, rawJsonTail(text)].filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0,
  );
  for (const c of repairCandidates) {
    try {
      return JSON.parse(jsonrepair(c));
    } catch {
      // fall through to the next candidate
    }
  }
  // Final tier: a weak model left an inner double-quote unescaped, which desyncs
  // both the balanced scanner and jsonrepair above. Escape inner quotes on the raw
  // tail (starts at the first bracket, so quote tracking is in sync), re-extract a
  // balanced value, and parse — strict first, then jsonrepair for any remaining
  // defect. Gated on the escape actually changing the text, so clean and
  // narration-only inputs reach `return null` exactly as before.
  const tail = rawJsonTail(text);
  if (tail) {
    const escaped = escapeInnerQuotes(tail);
    if (escaped !== tail) {
      const sliced = extractFencedJson(escaped) ?? escaped;
      try {
        return JSON.parse(sliced);
      } catch {
        // fall through to the repair attempt
      }
      try {
        return JSON.parse(jsonrepair(sliced));
      } catch {
        // give up — return null below
      }
    }
  }
  return null;
}
