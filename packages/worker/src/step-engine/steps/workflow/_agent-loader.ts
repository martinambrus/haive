import path from 'node:path';
import { readdirNoFollow, readRegularFileNoFollow } from '../onboarding/_helpers.js';
import { readFrontmatterFields, unquoteYamlScalar } from '../_yaml-scalar.js';
import { isSingleLine } from '../_untrusted-repo.js';

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
  const relDir = path.join('.claude', 'agents');
  const entries = await readdirNoFollow(repoPath, relDir);
  if (!entries) return [];
  const personas: AgentPersona[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.md')) continue;
    if (e.name.toLowerCase() === README_BASENAME) continue;
    const sourcePath = path.join(repoPath, relDir, e.name);
    const raw = await readRegularFileNoFollow(repoPath, path.join(relDir, e.name));
    if (raw === null) continue;
    const parsed = parseAgentFile(raw);
    if (!parsed) continue;
    const fallbackId = e.name.replace(/\.md$/i, '');
    const id = (parsed.frontmatter.name ?? fallbackId).trim();
    // `name` can be a `|` block scalar or a double-quoted scalar holding `\\n`, so an id
    // can span lines. Dropped rather than collapsed: every consumer round-trips an id
    // verbatim — the selector returns it, the dispatcher matches it, 07 writes the file
    // — so a rewritten one matches nothing, and an id that cannot be named on a line is
    // already unusable to every CLI that reads the same frontmatter.
    if (!id || !isSingleLine(id)) continue;
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

export interface ParsedAgentFile {
  frontmatter: Record<string, string>;
  body: string;
}

/** Exported for readers that want ONE agent file by name rather than the whole directory,
 *  so the frontmatter rules (no closing fence = unparseable, body after the fence) have a
 *  single implementation. */
export function parseAgentFile(raw: string): ParsedAgentFile | null {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }
  const closing = raw.indexOf('\n---', 3);
  if (closing === -1) return null;
  const fmText = raw.slice(3, closing).trim();
  const body = raw.slice(closing + 4).replace(/^\r?\n/, '');
  return { frontmatter: readFrontmatterFields(fmText), body };
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
    .map((s) => unquoteYamlScalar(s.trim()))
    .filter((s) => s.length > 0);
}
