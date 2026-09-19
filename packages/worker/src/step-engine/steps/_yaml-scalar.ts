/**
 * One YAML scalar encoding for every frontmatter value Haive writes, and its inverse for the
 * line-based readers that read those files back.
 *
 * Agent and skill frontmatter is parsed by several YAML implementations — claude's, grok's,
 * gemini's js-yaml, antigravity's — and they do not share claude's leniency. MEASURED with
 * `description: Security-focused review of a diff: injection, …` (4 baseline agents, and every
 * LLM-written description with a `: ` in it): claude 2.1.270 listed the agent, grok 1.0.34
 * dropped it from `spawn_subagent` without a word, and gemini 0.60.0 refused it with "YAML
 * frontmatter parsing failed: bad indentation of a mapping entry".
 */

import { parse } from 'yaml';

/**
 * `value` as a YAML scalar that every parser reads back as exactly `value`. It stays PLAIN when
 * it already round-trips under both YAML 1.1 and 1.2 — so a value that was always valid keeps
 * its bytes and no template hash moves — and is double-quoted otherwise. 1.1 matters because it
 * also resolves `yes`/`no`/`on`/`off` and timestamps, which a string field must not become.
 * JSON's string escapes are a subset of YAML's double-quoted ones, so JSON.stringify is exact.
 */
export function yamlScalar(value: string): string {
  const doc = `v: ${value}`;
  const plain = (['1.1', '1.2'] as const).every((version) => {
    try {
      return parse(doc, { version, logLevel: 'error' })?.v === value;
    } catch {
      return false;
    }
  });
  return plain ? value : JSON.stringify(value);
}

/**
 * The inverse, for readers that split `key: value` by line instead of parsing YAML (they must
 * keep reading hand-written files a real parser rejects). A double-quoted value is decoded —
 * falling back to unwrapping for a YAML-only escape JSON does not know — and a single-quoted one
 * unwrapped with its `''` escape undone. Anything else is returned unchanged.
 */
export function unquoteYamlScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded === 'string') return decoded;
    } catch {
      // e.g. `\x41` or `\e`: valid YAML, not JSON.
    }
    return raw.slice(1, -1);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** `|` or `>`, with an optional chomping indicator and indentation digit in either order. */
const BLOCK_SCALAR_HEADER = /^[|>](?:[+-]?[1-9]?|[1-9][+-])$/;

/**
 * The `key: value` fields of a frontmatter block, read by line so a file a YAML parser rejects
 * (a plain value holding `: `, written before `yamlScalar` existed) still yields its fields.
 * Values are unquoted; a block scalar (`>` folded, `|` literal) is read from the indented lines
 * under its key — MEASURED, 269 of the agent and skill files on this install carry
 * `description: >`, which a per-line split read as the literal ">"; a key with no value followed
 * by indented `k: v` lines yields dotted `key.k` fields.
 */
export function readFrontmatterFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  let parent: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key) continue;
    if (/^\s/.test(line)) {
      if (parent !== null) fields[`${parent}.${key}`] = unquoteYamlScalar(raw);
      continue;
    }
    parent = null;
    if (BLOCK_SCALAR_HEADER.test(raw)) {
      const body: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) {
        i += 1;
        body.push(lines[i]!);
      }
      fields[key] = blockScalarText(body, raw.startsWith('>'));
      continue;
    }
    fields[key] = unquoteYamlScalar(raw);
    if (raw === '') parent = key;
  }
  return fields;
}

/** A block scalar's content: de-indented, a folded one joined into paragraphs, trailing
 *  newlines dropped (every reader trims a field). */
function blockScalarText(body: string[], folded: boolean): string {
  const content = body.filter((l) => l.trim());
  if (content.length === 0) return '';
  const indent = Math.min(...content.map((l) => l.length - l.trimStart().length));
  const text = body.map((l) => l.slice(indent).trimEnd()).join('\n');
  if (!folded) return text.trim();
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').join(' ').trim())
    .filter(Boolean)
    .join('\n');
}
