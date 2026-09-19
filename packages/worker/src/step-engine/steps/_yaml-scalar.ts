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
