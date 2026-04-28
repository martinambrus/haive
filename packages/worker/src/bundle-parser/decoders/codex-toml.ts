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

interface FlatTomlFields {
  name?: string;
  description?: string;
  developer_instructions?: string;
}

/** Hand-rolled TOML parser that handles the three keys Haive's emitter
 *  produces: `name = "…"`, `description = "…"`, and
 *  `developer_instructions = """…"""`. Quoted strings unescape `\"`, `\\`,
 *  and triple-quoted blocks unescape `\"""`. Anything else is ignored — TOML
 *  files with extra keys still parse, but lossily. */
function parseFlatToml(text: string): FlatTomlFields {
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
      const endIdx = text.indexOf('"""', pos);
      if (endIdx < 0) break;
      const raw = text.slice(pos, endIdx);
      value = raw
        .replace(/\\"\\"\\"/g, '"""')
        .replace(/\\\\/g, '\\')
        .replace(/^\n/, '');
      pos = endIdx + 3;
    } else if (text[pos] === '"') {
      pos += 1;
      let collected = '';
      while (pos < text.length) {
        const ch = text[pos]!;
        if (ch === '\\' && text[pos + 1] !== undefined) {
          const next = text[pos + 1]!;
          if (next === 'n') collected += '\n';
          else if (next === 't') collected += '\t';
          else collected += next;
          pos += 2;
          continue;
        }
        if (ch === '"') {
          pos += 1;
          break;
        }
        collected += ch;
        pos += 1;
      }
      value = collected;
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
