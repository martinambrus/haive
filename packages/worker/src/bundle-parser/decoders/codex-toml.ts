import type { AgentSpec } from '@haive/shared';

/** Decode a Codex-flavour agent TOML file into an AgentSpec. Codex's schema
 *  (per https://developers.openai.com/codex/subagents) defines:
 *    name                   — required string
 *    description            — required string
 *    developer_instructions — required multiline string (system prompt body)
 *  Optional fields exist (model, model_reasoning_effort, sandbox_mode,
 *  mcp_servers) but the encoder side intentionally omits them so agents
 *  inherit from the parent session; the decoder mirrors that policy and
 *  ignores any extras present in user-supplied TOML. */
export function decodeCodexAgent(content: string, sourcePath: string): AgentSpec {
  const fields = parseFlatToml(content);
  const id = fields.name?.trim() || derivedIdFromPath(sourcePath);
  const description = fields.description?.trim() || `Agent imported from ${sourcePath}`;
  const instructions = fields.developer_instructions?.trim() ?? '';
  return {
    id,
    title: id,
    description,
    color: 'blue',
    field: 'general',
    tools: [],
    coreMission: instructions.length > 0 ? instructions : description,
    responsibilities: [],
    whenInvoked: [],
    executionSteps: [],
    outputFormat: '',
    qualityCriteria: [],
    antiPatterns: [],
  };
}

export interface FlatTomlFields {
  name?: string;
  description?: string;
  developer_instructions?: string;
}

const TOML_SHORT_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
};

/** Imports and persona reads are lenient, not TOML validation: preserve malformed,
 *  non-scalar and unknown escapes verbatim instead of silently losing a backslash.
 *  Continuations are decoded in this same pass so an escaped backslash cannot start one. */
function decodeTomlEscapes(raw: string, multiline = false): string {
  return raw.replace(
    /\\(?:([ \t]*\r?\n[ \t\r\n]*)|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([\s\S]))/g,
    (m, continuation, u4, u8, ch) => {
      if (continuation !== undefined) return multiline ? '' : m;
      if (ch !== undefined) return TOML_SHORT_ESCAPES[ch] ?? m;
      const code = parseInt(u4 ?? u8, 16);
      const isScalar = code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return isScalar ? String.fromCodePoint(code) : m;
    },
  );
}

/** Hand-rolled TOML parser that handles the three keys Haive's emitter
 *  produces: `name = "…"`, `description = "…"`, and
 *  `developer_instructions = """…"""`. Both quoted and triple-quoted strings
 *  decode the TOML 1.0 escape set. Anything else is ignored — TOML
 *  files with extra keys still parse, but lossily. */
export function parseFlatToml(text: string): FlatTomlFields {
  const out: FlatTomlFields = {};
  let pos = 0;
  while (pos < text.length) {
    // Skip whitespace and comment lines.
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
    if (pos >= text.length) break;
    if (text[pos] === '#') {
      while (pos < text.length && text[pos] !== '\n') pos += 1;
      continue;
    }
    const eqIdx = text.indexOf('=', pos);
    if (eqIdx < 0) break;
    const key = text.slice(pos, eqIdx).trim();
    pos = eqIdx + 1;
    while (pos < text.length && /[ \t]/.test(text[pos]!)) pos += 1;
    if (pos >= text.length) break;

    let value: string | null = null;
    if (text.startsWith('"""', pos)) {
      pos += 3;
      let raw = '';
      let closed = false;
      while (pos < text.length) {
        // An escaped quote is content, even immediately before two more quotes.
        if (text[pos] === '\\' && text[pos + 1] !== undefined) {
          raw += text.slice(pos, pos + 2);
          pos += 2;
          continue;
        }
        if (text.startsWith('"""', pos)) {
          let quotes = 3;
          while (quotes < 5 && text[pos + quotes] === '"') quotes += 1;
          // TOML permits one or two content quotes before the closing three.
          raw += '"'.repeat(quotes - 3);
          pos += quotes;
          closed = true;
          break;
        }
        raw += text[pos]!;
        pos += 1;
      }
      if (!closed) break;
      value = decodeTomlEscapes(raw.replace(/^\r?\n/, '').replace(/\r\n/g, '\n'), true);
    } else if (text[pos] === '"') {
      pos += 1;
      let raw = '';
      while (pos < text.length) {
        const ch = text[pos]!;
        if (ch === '\\' && text[pos + 1] !== undefined) {
          raw += ch + text[pos + 1]!;
          pos += 2;
          continue;
        }
        if (ch === '"') {
          pos += 1;
          break;
        }
        raw += ch;
        pos += 1;
      }
      value = decodeTomlEscapes(raw);
    } else {
      // Bare value — read until newline.
      const nlIdx = text.indexOf('\n', pos);
      const end = nlIdx < 0 ? text.length : nlIdx;
      value = text.slice(pos, end).trim();
      pos = end;
    }
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'developer_instructions') out.developer_instructions = value;
  }
  return out;
}

function derivedIdFromPath(sourcePath: string): string {
  const base = sourcePath.split('/').pop() ?? 'item';
  return base
    .replace(/\.(md|toml)$/i, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase();
}
