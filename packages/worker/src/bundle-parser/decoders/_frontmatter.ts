/** Lightweight YAML frontmatter splitter — handles only the subset Haive's
 *  generators emit (no anchors, no nested objects beyond `kb-references`,
 *  no quotes-aware multi-line strings). Returns the frontmatter as a flat
 *  record plus the body. Bundle agents authored with full YAML may lose
 *  structure here; the decoder is forgiving — unknown frontmatter keys are
 *  passed through unchanged for downstream consumers. */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { frontmatter: {}, body: text };
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const after = text.slice(`---${newline}`.length);
  const endMarker = `${newline}---${newline}`;
  const endIdx = after.indexOf(endMarker);
  if (endIdx < 0) return { frontmatter: {}, body: text };
  const fmText = after.slice(0, endIdx);
  const body = after.slice(endIdx + endMarker.length);
  const frontmatter: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of fmText.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const indented = /^\s+/.test(line);
    if (!indented) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      currentKey = key;
      frontmatter[key] = value;
    } else if (currentKey) {
      // nested key under the previous top-level key — Haive only uses this
      // shape for `kb-references:`, so fold the nested key into a dotted form.
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const nestedKey = line.slice(0, colonIdx).trim();
      const nestedValue = line.slice(colonIdx + 1).trim();
      frontmatter[`${currentKey}.${nestedKey}`] = nestedValue;
    }
  }
  return { frontmatter, body };
}

/** Parse a YAML inline-array string `[a, b, c]` into trimmed string entries.
 *  Returns an empty array when the input is empty or malformed. */
export function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return trimmed.length === 0 ? [] : [trimmed];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Extract the first H1 heading (`# Title`) from a markdown body. Returns
 *  null when no H1 is present. */
export function firstH1(body: string): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const match = raw.match(/^#\s+(.+?)\s*$/);
    if (match && match[1]) return match[1];
  }
  return null;
}
