import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';

interface SkillCandidate {
  id: string;
  label: string;
  source: 'kb' | 'framework';
  hint: string;
}

interface SkillGenDetect {
  candidates: SkillCandidate[];
}

interface SkillGenApply {
  written: { id: string; filePath: string }[];
  source: 'llm' | 'stub';
}

interface SkillKeyConcept {
  term: string;
  definition: string;
}

interface SkillNamedBlock {
  name: string;
  body: string;
}

interface SkillPitfall {
  title: string;
  body: string;
}

interface SkillCodeLocation {
  label: string;
  path: string;
}

export interface SkillSubSkill {
  /** Filename slug — kebab-case, no extension. Becomes `sub-skills/<slug>.md`. */
  slug: string;
  /** Full unique frontmatter `name` — by convention `<parent-id>-<slug>`. */
  name: string;
  /** H1 title rendered at the top of the sub-skill file. */
  title: string;
  /** Activation description shown in sub-skill frontmatter. */
  description: string;
  /** Optional grouping shown in parent SKILL.md's `## Sub-Skills` section. */
  category?: string;
  /** Short line shown next to the sub-skill link in the parent SKILL.md. */
  summary: string;
  /** Full markdown body of the sub-skill file (appears after the Identification block). */
  body: string;
  /** Optional extra rows for the Identification block (Parent row is auto-added). */
  identification?: { label: string; value: string }[];
}

export interface SkillRelated {
  /** Path from this skill's dir — e.g. `../statistics/SKILL.md`. */
  path: string;
  summary: string;
}

export interface SkillEntry {
  id: string;
  title: string;
  description: string;
  /** Fallback catch-all body when structured sections are absent. */
  instructions?: string;
  quickStart?: string;
  overview?: string;
  keyConcepts?: SkillKeyConcept[];
  /** Optional markdown table block — rendered under `## Quick Reference`. */
  quickReference?: string;
  decisionTree?: string;
  implementationPatterns?: SkillNamedBlock[];
  pitfalls?: SkillPitfall[];
  codeLocations?: SkillCodeLocation[];
  usage?: string;
  /** Progressive-disclosure leaves. Each entry writes to `sub-skills/<slug>.md`. */
  subSkills?: SkillSubSkill[];
  /** Cross-references to other skills in the same workspace. */
  relatedSkills?: SkillRelated[];
  /** Common-patterns block — shown under `## Common Patterns`. */
  commonPatterns?: SkillNamedBlock[];
}

async function listKbTopics(repo: string): Promise<string[]> {
  const dir = path.join(repo, '.claude', 'knowledge_base');
  if (!(await pathExists(dir))) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

export async function discoverSkillCandidates(
  repo: string,
  framework: string | null,
): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = [];
  const kbTopics = await listKbTopics(repo);
  for (const topic of kbTopics) {
    candidates.push({
      id: `${topic}-skill`,
      label: `${toTitle(topic)} skill`,
      source: 'kb',
      hint: `.claude/knowledge_base/${topic}.md`,
    });
  }
  if (framework && framework !== 'general' && framework !== 'unknown') {
    candidates.push({
      id: `${framework}-project`,
      label: `${toTitle(framework)} project skill`,
      source: 'framework',
      hint: `detected framework: ${framework}`,
    });
  }
  return candidates;
}

function toTitle(id: string): string {
  return id
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function parseSkillEntries(raw: unknown): SkillEntry[] {
  if (!raw) return [];
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    return raw.filter(isValidSkill);
  } else if (typeof raw === 'object' && raw !== null) {
    const asObj = raw as Record<string, unknown>;
    if (Array.isArray(asObj.skills)) {
      return (asObj.skills as unknown[]).filter(isValidSkill);
    }
    return [];
  } else {
    return [];
  }
  const out: SkillEntry[] = [];
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const body = match[1];
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (isValidSkill(item)) out.push(item);
      } else if (isValidSkill(parsed)) {
        out.push(parsed);
      } else if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).skills)
      ) {
        for (const item of (parsed as Record<string, unknown>).skills as unknown[]) {
          if (isValidSkill(item)) out.push(item);
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

function isValidSkill(val: unknown): val is SkillEntry {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.trim().length === 0) return false;
  if (typeof v.title !== 'string' || v.title.trim().length === 0) return false;
  if (typeof v.description !== 'string' || v.description.trim().length === 0) return false;
  // Require at least one body section OR at least one sub-skill.
  const hasBody =
    typeof v.instructions === 'string' ||
    typeof v.quickStart === 'string' ||
    typeof v.overview === 'string' ||
    Array.isArray(v.keyConcepts) ||
    typeof v.decisionTree === 'string' ||
    Array.isArray(v.implementationPatterns) ||
    Array.isArray(v.pitfalls) ||
    Array.isArray(v.codeLocations) ||
    (Array.isArray(v.subSkills) && (v.subSkills as unknown[]).length > 0);
  return hasBody;
}

function isValidSubSkill(val: unknown): val is SkillSubSkill {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  return (
    typeof v.slug === 'string' &&
    v.slug.trim().length > 0 &&
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.title === 'string' &&
    v.title.trim().length > 0 &&
    typeof v.description === 'string' &&
    v.description.trim().length > 0 &&
    typeof v.summary === 'string' &&
    v.summary.trim().length > 0 &&
    typeof v.body === 'string' &&
    v.body.trim().length > 0
  );
}

export function sanitizeSubSkills(entry: SkillEntry): SkillSubSkill[] {
  if (!entry.subSkills) return [];
  const seen = new Set<string>();
  const out: SkillSubSkill[] = [];
  for (const raw of entry.subSkills) {
    if (!isValidSubSkill(raw)) continue;
    const slug = raw.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...raw, slug });
  }
  return out;
}

function renderKeyConcepts(items: SkillKeyConcept[]): string[] {
  return items
    .filter((c) => c && typeof c.term === 'string' && typeof c.definition === 'string')
    .map((c) => `- **${c.term.trim()}** — ${c.definition.trim()}`);
}

function renderNamedBlocks(items: SkillNamedBlock[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item.name !== 'string' || typeof item.body !== 'string') continue;
    out.push(`### ${item.name.trim()}`, '', item.body.trim(), '');
  }
  return out;
}

function renderPitfalls(items: SkillPitfall[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || typeof item.body !== 'string') continue;
    out.push(`### ${item.title.trim()}`, '', item.body.trim(), '');
  }
  return out;
}

function renderCodeLocations(items: SkillCodeLocation[]): string[] {
  return items
    .filter((c) => c && typeof c.label === 'string' && typeof c.path === 'string')
    .map((c) => `- **${c.label.trim()}** — \`${c.path.trim()}\``);
}

/** Group sub-skills by category and render the `## Sub-Skills` block. Any sub-skill
 *  without a category is bucketed under "Topics". Ordering follows first appearance. */
function renderSubSkillsBlock(subs: SkillSubSkill[]): string[] {
  if (subs.length === 0) return [];
  const groups = new Map<string, SkillSubSkill[]>();
  for (const s of subs) {
    const key = s.category && s.category.trim().length > 0 ? s.category.trim() : 'Topics';
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  const out: string[] = ['## Sub-Skills', ''];
  for (const [cat, list] of groups) {
    if (groups.size > 1) out.push(`### ${cat}`, '');
    for (const s of list) {
      out.push(`- [sub-skills/${s.slug}.md](./sub-skills/${s.slug}.md) - ${s.summary.trim()}`);
    }
    out.push('');
  }
  return out;
}

/** Auto-generate a Decision Tree from sub-skills when the LLM didn't provide one. */
function decisionTreeFromSubSkills(subs: SkillSubSkill[]): string {
  const lines = ['```', 'Working in this domain?'];
  for (const s of subs) lines.push(`|-- ${s.title}? -> See sub-skills/${s.slug}.md`);
  lines.push('```');
  return lines.join('\n');
}

function renderRelatedSkills(items: SkillRelated[]): string[] {
  return items
    .filter((r) => r && typeof r.path === 'string' && typeof r.summary === 'string')
    .map((r) => `- [${r.path.trim()}](${r.path.trim()}) - ${r.summary.trim()}`);
}

/** Multi-line YAML-folded description keeps Claude Code's 1024-char limit honest when
 *  the LLM produces a long activation blurb. Short descriptions stay on one line. */
function yamlDescription(desc: string): string {
  const clean = desc.trim();
  if (clean.length <= 120 && !clean.includes('\n')) return `description: ${clean}`;
  const wrapped = clean.replace(/\s+/g, ' ').match(/.{1,78}(?:\s|$)/g) ?? [clean];
  return ['description: >', ...wrapped.map((line) => `  ${line.trim()}`)].join('\n');
}

export function skillToMarkdown(entry: SkillEntry): string {
  const subs = sanitizeSubSkills(entry);
  const fm = ['---', `name: ${entry.id}`, yamlDescription(entry.description), '---', ''].join('\n');
  const body: string[] = [`# ${entry.title}`, ''];

  if (entry.quickStart && entry.quickStart.trim().length > 0) {
    body.push('## Quick Start', '', entry.quickStart.trim(), '');
  }

  body.push('## Overview', '');
  body.push((entry.overview ?? entry.description).trim(), '');

  if (entry.keyConcepts && entry.keyConcepts.length > 0) {
    const rendered = renderKeyConcepts(entry.keyConcepts);
    if (rendered.length > 0) {
      body.push('## Key Concepts', '', ...rendered, '');
    }
  }

  if (entry.quickReference && entry.quickReference.trim().length > 0) {
    body.push('## Quick Reference', '', entry.quickReference.trim(), '');
  }

  if (entry.decisionTree && entry.decisionTree.trim().length > 0) {
    body.push('## Decision Tree', '', entry.decisionTree.trim(), '');
  } else if (subs.length > 0) {
    body.push('## Decision Tree', '', decisionTreeFromSubSkills(subs), '');
  }

  body.push(...renderSubSkillsBlock(subs));

  if (entry.relatedSkills && entry.relatedSkills.length > 0) {
    const rendered = renderRelatedSkills(entry.relatedSkills);
    if (rendered.length > 0) {
      body.push('## Related Skills', '', ...rendered, '');
    }
  }

  if (entry.implementationPatterns && entry.implementationPatterns.length > 0) {
    const rendered = renderNamedBlocks(entry.implementationPatterns);
    if (rendered.length > 0) {
      body.push('## Implementation Patterns', '', ...rendered);
    }
  }

  if (entry.commonPatterns && entry.commonPatterns.length > 0) {
    const rendered = renderNamedBlocks(entry.commonPatterns);
    if (rendered.length > 0) {
      body.push('## Common Patterns', '', ...rendered);
    }
  }

  if (entry.pitfalls && entry.pitfalls.length > 0) {
    const rendered = renderPitfalls(entry.pitfalls);
    if (rendered.length > 0) {
      body.push('## Pitfalls and Edge Cases', '', ...rendered);
    }
  }

  if (entry.codeLocations && entry.codeLocations.length > 0) {
    const rendered = renderCodeLocations(entry.codeLocations);
    if (rendered.length > 0) {
      body.push('## Code Locations', '', ...rendered, '');
    }
  }

  if (entry.instructions && entry.instructions.trim().length > 0) {
    body.push('## Additional Notes', '', entry.instructions.trim(), '');
  }

  if (entry.usage && entry.usage.trim().length > 0) {
    body.push('## Usage', '', entry.usage.trim(), '');
  }

  return fm + body.join('\n');
}

/** Renders one sub-skill file. Frontmatter uses the full `<parent>-<slug>` name.
 *  An Identification block is auto-prepended so every sub-skill links back to its
 *  parent SKILL.md — callers can append extra rows via `sub.identification`. */
export function subSkillToMarkdown(parentId: string, sub: SkillSubSkill): string {
  const fm = ['---', `name: ${sub.name}`, yamlDescription(sub.description), '---', ''].join('\n');
  const ident: string[] = ['## Identification', ''];
  if (sub.identification) {
    for (const row of sub.identification) {
      if (!row || typeof row.label !== 'string' || typeof row.value !== 'string') continue;
      ident.push(`- **${row.label.trim()}**: ${row.value.trim()}`);
    }
  }
  ident.push(`- **Parent**: [${parentId}/SKILL.md](../SKILL.md)`);
  ident.push('');

  return [fm, `# ${sub.title}`, '', ...ident, sub.body.trim(), ''].join('\n');
}

/** Emits the `.claude/skills/README.md` domain-index. Only lists skills actually
 *  written in this run; the user can re-run onboarding to refresh. */
export function skillsReadmeMarkdown(
  written: { id: string; title: string; description: string }[],
): string {
  const rows = [...written].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [
    '# Skills Index',
    '',
    'Domain-specific knowledge for this codebase. Agents load a SKILL.md when working on the matching domain, then drill down into `sub-skills/` as needed.',
    '',
    '## Skill Architecture',
    '',
    '- **AGENTS**: technical/framework expertise (HOW to code). Live in `.claude/agents/`.',
    '- **SKILLS**: business/domain knowledge (WHAT to build). Live here.',
    '- **Progressive disclosure**: metadata (always) -> SKILL.md (when triggered) -> sub-skills (when specific topic needed).',
    '',
    '## Domains',
    '',
    '| Skill | Summary |',
    '|-------|---------|',
  ];
  for (const r of rows) {
    const desc = r.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    lines.push(`| [${r.id}](./${r.id}/SKILL.md) | ${desc} |`);
  }
  lines.push('');
  lines.push('## Directory Layout');
  lines.push('');
  lines.push('```');
  lines.push('.claude/skills/');
  lines.push('  {domain}/');
  lines.push('    SKILL.md                 # domain overview with YAML frontmatter');
  lines.push('    sub-skills/');
  lines.push('      {topic}.md             # drill-down docs (one per topic)');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

async function stubSkillMarkdown(candidate: SkillCandidate, repo: string): Promise<string> {
  let kbPreview = '';
  if (candidate.source === 'kb') {
    const topic = candidate.id.replace(/-skill$/, '');
    const kbFile = path.join(repo, '.claude', 'knowledge_base', `${topic}.md`);
    try {
      const text = await readFile(kbFile, 'utf8');
      kbPreview = text.trim().slice(0, 1500);
    } catch {
      kbPreview = '';
    }
  }
  const fm = [
    '---',
    `name: ${candidate.id}`,
    `description: ${candidate.label} (stub — replace with real description before use)`,
    '---',
    '',
  ].join('\n');
  const lines = [
    `# ${candidate.label}`,
    '',
    '## Quick Start',
    '',
    '```',
    'Replace with a short code snippet or command that demonstrates typical usage.',
    '```',
    '',
    '## Overview',
    '',
    `Stub for **${candidate.label}**. Hint: ${candidate.hint}.`,
    'Replace this paragraph with 1-2 sentences describing when this skill applies and why it exists.',
    '',
    '## Key Concepts',
    '',
    '- **Concept** — Replace with the main term this skill teaches.',
    '- **Concept** — Replace with another term this skill teaches.',
    '',
    '## Decision Tree',
    '',
    '```',
    'Is <condition>?',
    '  Yes → use approach A',
    '  No  → use approach B',
    '```',
    '',
    '## Implementation Patterns',
    '',
    '### Pattern name',
    '',
    'Replace with the pattern body, including concrete examples.',
    '',
    '## Common Pitfalls',
    '',
    '### Pitfall name',
    '',
    'Replace with what typically goes wrong and how to avoid it.',
    '',
    '## Code Locations',
    '',
    `- **Source** — \`${candidate.hint}\``,
    '',
  ];
  if (kbPreview) {
    lines.push('## Source knowledge base excerpt');
    lines.push('');
    lines.push(kbPreview);
    lines.push('');
  }
  return fm + lines.join('\n');
}

export const skillGenerationStep: StepDefinition<SkillGenDetect, SkillGenApply> = {
  metadata: {
    id: '09_5-skill-generation',
    workflowType: 'onboarding',
    index: 11,
    title: 'Skill generation',
    description:
      'Generates .claude/skills/<id>/SKILL.md entries for each selected candidate. Candidates are derived from the knowledge base topics and the detected framework.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<SkillGenDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const data = (prev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string } }
      | undefined;
    const framework = data?.project?.framework ?? null;
    const candidates = await discoverSkillCandidates(ctx.repoPath, framework);
    ctx.logger.info({ candidateCount: candidates.length }, 'skill candidates discovered');
    return { candidates };
  },

  form(_ctx, detected): FormSchema {
    const options = detected.candidates.map((c) => ({
      value: c.id,
      label: `${c.label} — ${c.hint}`,
    }));
    return {
      title: 'Generate skill entries',
      description:
        'Select which skill entries to generate. Each selected skill produces a .claude/skills/<id>/SKILL.md file.',
      fields: [
        {
          type: 'multi-select',
          id: 'selectedSkills',
          label: 'Skills to generate',
          options,
          defaults: options.map((o) => o.value),
        },
      ],
      submitLabel: 'Generate skills',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    buildPrompt: (args) => {
      const detected = args.detected as SkillGenDetect;
      const values = args.formValues as { selectedSkills?: string[] };
      const selected = new Set(values.selectedSkills ?? []);
      const picked = detected.candidates.filter((c) => selected.has(c.id));
      const bullets = picked
        .map((c) => `- id: ${c.id}; label: ${c.label}; source: ${c.source}; hint: ${c.hint}`)
        .join('\n');
      return [
        'You are generating Claude Code skill entries for an engineering onboarding workflow.',
        '',
        'Each skill is a directory `.claude/skills/<id>/` containing:',
        '  - `SKILL.md` — the domain overview (metadata + key concepts + decision tree + links into sub-skills)',
        '  - `sub-skills/<slug>.md` — one file per drill-down topic (progressive disclosure leaves)',
        '',
        'For each skill below, emit ONE JSON object inside a ```json fenced code block.',
        '',
        'The JSON shape (SKILL.md is the loader — keep it concise. Push detail into sub-skills):',
        '{',
        '  "id": "<skill id — kebab-case>",',
        '  "title": "<skill title — Title Case>",',
        '  "description": "<activation description shown in SKILL.md frontmatter — include trigger keywords>",',
        '  "quickStart": "<short code block or command demonstrating typical usage — optional>",',
        '  "overview": "<1-2 paragraphs: what this skill is, when it applies, why it exists>",',
        '  "keyConcepts": [ { "term": "<term>", "definition": "<one-sentence definition>" } ],',
        '  "quickReference": "<optional markdown table (`| Concept | Value |`) summarising constants and sources>",',
        '  "decisionTree": "<optional markdown block routing the reader to the right sub-skill — when omitted, one is auto-generated from subSkills>",',
        '  "implementationPatterns": [ { "name": "<pattern name>", "body": "<markdown pattern body with concrete examples>" } ],',
        '  "commonPatterns": [ { "name": "<pattern name>", "body": "<short everyday usage snippet>" } ],',
        '  "pitfalls": [ { "title": "<pitfall name>", "body": "<explanation + mitigation>" } ],',
        '  "codeLocations": [ { "label": "<human-friendly label>", "path": "<relative path in this repo>" } ],',
        '  "relatedSkills": [ { "path": "<../other-skill/SKILL.md>", "summary": "<one line>" } ],',
        '  "subSkills": [',
        '    {',
        '      "slug": "<kebab-case filename, no extension>",',
        '      "name": "<full frontmatter name — convention: \\"<skill-id>-<slug>\\">",',
        '      "title": "<H1 title of the sub-skill file>",',
        '      "description": "<activation description in sub-skill frontmatter — trigger keywords>",',
        '      "category": "<optional grouping heading shown under ## Sub-Skills in parent>",',
        '      "summary": "<short line shown beside the sub-skill link in parent SKILL.md>",',
        '      "body": "<full markdown body — Purpose, Process, Code Pattern, Pitfalls, Related, etc.>",',
        '      "identification": [ { "label": "Function", "value": "lib/foo.mjs::bar" } ]',
        '    }',
        '  ],',
        '  "instructions": "<optional extra markdown notes that do not fit other sections>",',
        '  "usage": "<optional usage examples in markdown>"',
        '}',
        '',
        'Rules:',
        '- Treat SKILL.md as a lightweight index. It should describe the domain and route the reader to sub-skills — NOT duplicate the full sub-skill content.',
        '- Each sub-skill is a leaf document covering one specific topic. Produce 4-10 sub-skills per skill when the domain is broad enough; fewer is fine for narrow skills.',
        '- Sub-skill `body` should include its own headings (e.g. `## Purpose`, `## Process`, `## Code Pattern`, `## Pitfalls`). It must NOT restate the parent overview.',
        '- Ground every claim in this specific repository; prefer a concrete file path over a generic library reference.',
        '- When a skill is sourced from a knowledge-base file, mirror the terminology that file uses.',
        '- Do not emit prose outside the fenced JSON blocks.',
        '',
        'Skills to generate:',
        bullets,
      ].join('\n');
    },
    timeoutMs: 60 * 60 * 1000,
  },

  async apply(ctx, args): Promise<SkillGenApply> {
    const detected = args.detected as SkillGenDetect;
    const values = args.formValues as { selectedSkills?: string[] };
    const selected = new Set(values.selectedSkills ?? []);
    const picked = detected.candidates.filter((c) => selected.has(c.id));

    const entries = parseSkillEntries(args.llmOutput ?? null);
    const byId = new Map<string, SkillEntry>();
    for (const e of entries) byId.set(e.id, e);

    const written: { id: string; filePath: string }[] = [];
    const summaryForReadme: { id: string; title: string; description: string }[] = [];
    let usedLlm = 0;
    let subSkillsWritten = 0;

    for (const candidate of picked) {
      const dir = path.join(ctx.repoPath, '.claude', 'skills', candidate.id);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, 'SKILL.md');
      const entry = byId.get(candidate.id);
      const markdown = entry
        ? skillToMarkdown(entry)
        : await stubSkillMarkdown(candidate, ctx.repoPath);
      if (entry) usedLlm += 1;
      await writeFile(filePath, markdown, 'utf8');
      written.push({ id: candidate.id, filePath });

      if (entry) {
        const subs = sanitizeSubSkills(entry);
        if (subs.length > 0) {
          const subDir = path.join(dir, 'sub-skills');
          await mkdir(subDir, { recursive: true });
          for (const sub of subs) {
            const subPath = path.join(subDir, `${sub.slug}.md`);
            await writeFile(subPath, subSkillToMarkdown(entry.id, sub), 'utf8');
            subSkillsWritten += 1;
          }
        }
        summaryForReadme.push({
          id: entry.id,
          title: entry.title,
          description: entry.description,
        });
      } else {
        summaryForReadme.push({
          id: candidate.id,
          title: candidate.label,
          description: `${candidate.label} (stub — replace with real description before use)`,
        });
      }
    }

    if (summaryForReadme.length > 0) {
      const readmePath = path.join(ctx.repoPath, '.claude', 'skills', 'README.md');
      await mkdir(path.dirname(readmePath), { recursive: true });
      await writeFile(readmePath, skillsReadmeMarkdown(summaryForReadme), 'utf8');
    }

    const source: 'llm' | 'stub' = usedLlm > 0 ? 'llm' : 'stub';
    ctx.logger.info(
      { written: written.length, subSkillsWritten, llmEntries: usedLlm, source },
      'skills written',
    );
    return { written, source };
  },
};
