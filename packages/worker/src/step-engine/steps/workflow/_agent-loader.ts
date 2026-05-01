import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../onboarding/_helpers.js';

export interface AgentPersona {
  id: string;
  title: string;
  description: string;
  field: string | null;
  color: string | null;
  allowedTools: string[];
  body: string;
  sourcePath: string;
}

const README_BASENAME = 'readme.md';

export async function loadAgentPersonas(repoPath: string): Promise<AgentPersona[]> {
  const dir = path.join(repoPath, '.claude', 'agents');
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const personas: AgentPersona[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.md')) continue;
    if (e.name.toLowerCase() === README_BASENAME) continue;
    const sourcePath = path.join(dir, e.name);
    let raw: string;
    try {
      raw = await readFile(sourcePath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseAgentFile(raw);
    if (!parsed) continue;
    const fallbackId = e.name.replace(/\.md$/i, '');
    const id = (parsed.frontmatter.name ?? fallbackId).trim();
    if (!id) continue;
    personas.push({
      id,
      title: titleFromBody(parsed.body) ?? id,
      description: (parsed.frontmatter.description ?? '').trim(),
      field: nullableString(parsed.frontmatter.field),
      color: nullableString(parsed.frontmatter.color),
      allowedTools: parseToolList(parsed.frontmatter['allowed-tools']),
      body: parsed.body.trim(),
      sourcePath,
    });
  }
  personas.sort((a, b) => a.id.localeCompare(b.id));
  return personas;
}

interface ParsedAgentFile {
  frontmatter: Record<string, string>;
  body: string;
}

function parseAgentFile(raw: string): ParsedAgentFile | null {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }
  const closing = raw.indexOf('\n---', 3);
  if (closing === -1) return null;
  const fmText = raw.slice(3, closing).trim();
  const body = raw.slice(closing + 4).replace(/^\r?\n/, '');
  const frontmatter: Record<string, string> = {};
  for (const rawLine of fmText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    frontmatter[key] = stripQuotes(value);
  }
  return { frontmatter, body };
}

function titleFromBody(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m?.[1]?.trim() ?? null;
}

function nullableString(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseToolList(v: string | undefined): string[] {
  if (!v) return [];
  const trimmed = v.trim();
  if (!trimmed) return [];
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s.charAt(0);
    const last = s.charAt(s.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}
