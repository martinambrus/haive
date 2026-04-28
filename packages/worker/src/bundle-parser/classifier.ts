import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CustomBundleItemSourceFormat } from '@haive/shared';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  '__pycache__',
  'dist',
  'build',
  '.next',
]);

export interface AgentFile {
  kind: 'agent';
  sourceFormat: CustomBundleItemSourceFormat;
  sourcePath: string;
  absPath: string;
}

export interface SkillFolder {
  kind: 'skill';
  sourceFormat: CustomBundleItemSourceFormat;
  /** Path of the SKILL.md file relative to the bundle root. */
  sourcePath: string;
  absPath: string;
  /** Sibling sub-skill files inside `<skillDir>/sub-skills/`. Empty when none. */
  subSkillFiles: { sourcePath: string; absPath: string }[];
}

export interface UnknownFile {
  kind: 'unknown';
  sourcePath: string;
  absPath: string;
  reason: string;
}

export interface ClassifiedBundle {
  agents: AgentFile[];
  skills: SkillFolder[];
  unknown: UnknownFile[];
}

interface FoundFile {
  rel: string;
  abs: string;
}

interface FoundDir {
  rel: string;
  abs: string;
}

async function walk(root: string): Promise<{ files: FoundFile[]; dirs: FoundDir[] }> {
  const files: FoundFile[] = [];
  const dirs: FoundDir[] = [];
  async function visit(currentAbs: string, currentRel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(currentAbs, entry.name);
      const rel = currentRel === '' ? entry.name : `${currentRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        dirs.push({ rel, abs });
        await visit(abs, rel);
      } else if (entry.isFile()) {
        files.push({ rel, abs });
      }
    }
  }
  await visit(root, '');
  return { files, dirs };
}

function detectAgentFormat(rel: string): CustomBundleItemSourceFormat | null {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.toml')) {
    if (lower.includes('/agents/') || lower.startsWith('agents/')) return 'codex-toml';
    return null;
  }
  if (!lower.endsWith('.md')) return null;
  // Path-based hint takes priority — a markdown file living under a CLI's
  // native dir is parsed as that CLI's flavour.
  if (lower.includes('/.gemini/agents/') || lower.startsWith('.gemini/agents/')) return 'gemini-md';
  if (lower.includes('/.claude/agents/') || lower.startsWith('.claude/agents/')) return 'claude-md';
  if (lower.includes('/agents/') || lower.startsWith('agents/')) return 'claude-md';
  return null;
}

function detectSkillFormat(skillRel: string): CustomBundleItemSourceFormat | null {
  const lower = skillRel.toLowerCase();
  if (lower.includes('/.gemini/skills/') || lower.startsWith('.gemini/skills/')) return 'gemini-md';
  // .claude/skills/, .agents/skills/, plain skills/ all carry markdown SKILL.md
  // bodies — same on-disk shape regardless of which CLI exposes the dir.
  if (
    lower.includes('/.claude/skills/') ||
    lower.startsWith('.claude/skills/') ||
    lower.includes('/.agents/skills/') ||
    lower.startsWith('.agents/skills/') ||
    lower.includes('/skills/') ||
    lower.startsWith('skills/')
  ) {
    return 'claude-md';
  }
  return null;
}

/** Walk an extracted bundle tree and group its contents into agents, skills,
 *  and unrecognised leftovers. Skill grouping treats `<dir>/SKILL.md` as the
 *  anchor and pulls in every `<dir>/sub-skills/*.md` sibling so the parser
 *  can decode the parent + leaves in one pass. */
export async function classifyBundle(extractedRoot: string): Promise<ClassifiedBundle> {
  const { files } = await walk(extractedRoot);

  const agents: AgentFile[] = [];
  const skills: SkillFolder[] = [];
  const unknown: UnknownFile[] = [];
  const claimed = new Set<string>();

  // First pass: SKILL.md anchors. Each anchor claims its sibling sub-skills.
  for (const file of files) {
    const base = path.basename(file.rel);
    if (base !== 'SKILL.md') continue;
    const skillFormat = detectSkillFormat(file.rel);
    if (!skillFormat) {
      unknown.push({
        kind: 'unknown',
        sourcePath: file.rel,
        absPath: file.abs,
        reason: 'SKILL.md outside any recognised skills dir',
      });
      claimed.add(file.rel);
      continue;
    }
    const skillDir = path.posix.dirname(file.rel);
    const subSkillPrefix = `${skillDir}/sub-skills/`;
    const subSkillFiles = files
      .filter((f) => f.rel.startsWith(subSkillPrefix) && f.rel.toLowerCase().endsWith('.md'))
      .map((f) => ({ sourcePath: f.rel, absPath: f.abs }));
    skills.push({
      kind: 'skill',
      sourceFormat: skillFormat,
      sourcePath: file.rel,
      absPath: file.abs,
      subSkillFiles,
    });
    claimed.add(file.rel);
    for (const sub of subSkillFiles) claimed.add(sub.sourcePath);
  }

  // Second pass: agent files outside any claimed skill region.
  for (const file of files) {
    if (claimed.has(file.rel)) continue;
    const base = path.basename(file.rel).toLowerCase();
    if (base.startsWith('readme.')) {
      claimed.add(file.rel);
      continue;
    }
    const fmt = detectAgentFormat(file.rel);
    if (fmt) {
      agents.push({ kind: 'agent', sourceFormat: fmt, sourcePath: file.rel, absPath: file.abs });
      claimed.add(file.rel);
      continue;
    }
  }

  // Anything left is unknown (only `.md` / `.toml` files are reported — the
  // long tail of binary or unrelated files is dropped silently).
  for (const file of files) {
    if (claimed.has(file.rel)) continue;
    const lower = file.rel.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.toml') || lower.endsWith('.json')) {
      unknown.push({
        kind: 'unknown',
        sourcePath: file.rel,
        absPath: file.abs,
        reason: 'unrecognised location',
      });
    }
  }

  return { agents, skills, unknown };
}
