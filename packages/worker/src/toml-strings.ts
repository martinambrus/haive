/** TOML 1.0 basic-string encoding shared by agent definitions and MCP config. */
const TOML_SHORT_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

function tomlEscape(ch: string): string {
  return (
    TOML_SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  );
}

export function tomlBasicString(value: string): string {
  return `"${value.replace(/[\\"\u0000-\u001F\u007F]/g, tomlEscape)}"`;
}

export function tomlMultilineBasicString(value: string): string {
  const escaped = value.replace(/[\\\u0000-\u0008\u000B-\u001F\u007F]|"""/g, (m) =>
    m === '"""' ? '\\"\\"\\"' : tomlEscape(m),
  );
  return `"""\n${escaped}\n"""`;
}

/** A single key segment, never a dotted path. Keep ordinary keys byte-identical. */
export function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlBasicString(value);
}
