import path from 'node:path';
import { readdirNoFollow } from '@haive/shared/fs-safe';
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

// Every item carries its BUNDLE-RELATIVE `sourcePath` and nothing absolute. An `absPath` beside it
// would be a path built by name, which is exactly the redirect the anchored reads exist to remove:
// the next caller reaches for it with a plain `readFile` and the containment is gone. Consumers pass
// `sourcePath` back through the same (anchor, rootRel) pair they classified with.

export interface AgentFile {
  kind: 'agent';
  sourceFormat: CustomBundleItemSourceFormat;
  sourcePath: string;
}

export interface SkillFolder {
  kind: 'skill';
  sourceFormat: CustomBundleItemSourceFormat;
  /** Path of the SKILL.md file relative to the bundle root. */
  sourcePath: string;
  /** Sibling sub-skill files inside `<skillDir>/sub-skills/`. Empty when none. */
  subSkillFiles: { sourcePath: string }[];
}

export interface UnknownFile {
  kind: 'unknown';
  sourcePath: string;
  reason: string;
}

export interface ClassifiedBundle {
  agents: AgentFile[];
  skills: SkillFolder[];
  unknown: UnknownFile[];
}

interface FoundFile {
  rel: string;
}

interface FoundDir {
  rel: string;
}

/** Walk the tree at `<anchor>/<rootRel>`, collecting paths relative to THAT root.
 *
 *  Two rels are tracked because they answer different questions: `anchorRel` is what the primitives
 *  walk, and `rel` is what the bundle calls the file — the value stored in
 *  `custom_bundle_items.source_path`, which must stay bundle-relative however deep the anchor sits. */
async function walk(
  anchor: string,
  rootRel: string,
): Promise<{ files: FoundFile[]; dirs: FoundDir[] }> {
  const files: FoundFile[] = [];
  const dirs: FoundDir[] = [];
  async function visit(anchorRel: string, rel: string): Promise<void> {
    // Lenient: a directory that cannot be listed — absent, unreadable, or a link standing where a
    // directory should be — contributes nothing, which is exactly what the `catch` here did.
    const entries = await readdirNoFollow(anchor, anchorRel);
    if (entries === null) return;
    for (const entry of entries) {
      const childAnchorRel = anchorRel === '' ? entry.name : `${anchorRel}/${entry.name}`;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        dirs.push({ rel: childRel });
        await visit(childAnchorRel, childRel);
      } else if (entry.isFile()) {
        // A link is LISTED by readdir but is neither `isDirectory` nor `isFile`, so it falls through
        // both branches and is skipped — that was already true and is not a change.
        files.push({ rel: childRel });
      }
    }
  }
  await visit(rootRel, '');
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
export async function classifyBundle(anchor: string, rootRel: string): Promise<ClassifiedBundle> {
  const { files } = await walk(anchor, rootRel);

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
        reason: 'SKILL.md outside any recognised skills dir',
      });
      claimed.add(file.rel);
      continue;
    }
    const skillDir = path.posix.dirname(file.rel);
    const subSkillPrefix = `${skillDir}/sub-skills/`;
    const subSkillFiles = files
      .filter((f) => f.rel.startsWith(subSkillPrefix) && f.rel.toLowerCase().endsWith('.md'))
      .map((f) => ({ sourcePath: f.rel }));
    skills.push({
      kind: 'skill',
      sourceFormat: skillFormat,
      sourcePath: file.rel,
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
      agents.push({ kind: 'agent', sourceFormat: fmt, sourcePath: file.rel });
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
        reason: 'unrecognised location',
      });
    }
  }

  return { agents, skills, unknown };
}
