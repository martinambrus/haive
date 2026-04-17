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

interface SkillEntry {
  id: string;
  title: string;
  description: string;
  /** Fallback catch-all body when structured sections are absent. */
  instructions?: string;
  quickStart?: string;
  overview?: string;
  keyConcepts?: SkillKeyConcept[];
  decisionTree?: string;
  implementationPatterns?: SkillNamedBlock[];
  pitfalls?: SkillPitfall[];
  codeLocations?: SkillCodeLocation[];
  usage?: string;
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
  // Require at least one body section.
  const hasBody =
    typeof v.instructions === 'string' ||
    typeof v.quickStart === 'string' ||
    typeof v.overview === 'string' ||
    Array.isArray(v.keyConcepts) ||
    typeof v.decisionTree === 'string' ||
    Array.isArray(v.implementationPatterns) ||
    Array.isArray(v.pitfalls) ||
    Array.isArray(v.codeLocations);
  return hasBody;
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

function skillToMarkdown(entry: SkillEntry): string {
  const fm = ['---', `name: ${entry.id}`, `description: ${entry.description}`, '---', ''].join(
    '\n',
  );
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

  if (entry.decisionTree && entry.decisionTree.trim().length > 0) {
    body.push('## Decision Tree', '', entry.decisionTree.trim(), '');
  }

  if (entry.implementationPatterns && entry.implementationPatterns.length > 0) {
    const rendered = renderNamedBlocks(entry.implementationPatterns);
    if (rendered.length > 0) {
      body.push('## Implementation Patterns', '', ...rendered);
    }
  }

  if (entry.pitfalls && entry.pitfalls.length > 0) {
    const rendered = renderPitfalls(entry.pitfalls);
    if (rendered.length > 0) {
      body.push('## Common Pitfalls', '', ...rendered);
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
    optional: true,
    buildPrompt: (args) => {
      const detected = args.detected as SkillGenDetect;
      const values = args.formValues as { selectedSkills?: string[] };
      const selected = new Set(values.selectedSkills ?? []);
      const picked = detected.candidates.filter((c) => selected.has(c.id));
      const bullets = picked
        .map((c) => `- id: ${c.id}; label: ${c.label}; source: ${c.source}; hint: ${c.hint}`)
        .join('\n');
      return [
        'You are generating Claude Code skill entries (`.claude/skills/<id>/SKILL.md`) for an engineering onboarding workflow.',
        'For each skill below, emit ONE JSON object inside a ```json fenced code block.',
        '',
        'The JSON shape (all sections except `instructions` are strongly preferred; provide as many as truly apply):',
        '{',
        '  "id": "<skill id — kebab-case>",',
        '  "title": "<skill title — Title Case>",',
        '  "description": "<one-sentence activation description — shown in skill frontmatter>",',
        '  "quickStart": "<short code block or command demonstrating typical usage — optional>",',
        '  "overview": "<1-2 paragraphs: what this skill is, when it applies, why it exists>",',
        '  "keyConcepts": [ { "term": "<term>", "definition": "<one-sentence definition>" } ],',
        '  "decisionTree": "<markdown block — usually a fenced code block — that walks through the decision path>",',
        '  "implementationPatterns": [ { "name": "<pattern name>", "body": "<markdown pattern body with concrete examples>" } ],',
        '  "pitfalls": [ { "title": "<pitfall name>", "body": "<markdown explanation of the pitfall and the mitigation>" } ],',
        '  "codeLocations": [ { "label": "<human-friendly label>", "path": "<relative path in this repo>" } ],',
        '  "instructions": "<optional extra markdown notes that do not fit the structured sections>",',
        '  "usage": "<optional usage examples in markdown>"',
        '}',
        '',
        'Rules:',
        '- Ground every claim in this specific repository; prefer a concrete file path over a generic library reference.',
        '- When a skill is sourced from a knowledge-base file, mirror the terminology that file uses.',
        '- Include at least one entry in `keyConcepts`, `implementationPatterns`, `pitfalls`, and `codeLocations` whenever plausible.',
        '- Do not emit prose outside the fenced JSON blocks.',
        '',
        'Skills to generate:',
        bullets,
      ].join('\n');
    },
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
    let usedLlm = 0;
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
    }
    const source: 'llm' | 'stub' = usedLlm > 0 ? 'llm' : 'stub';
    ctx.logger.info({ written: written.length, llmEntries: usedLlm, source }, 'skills written');
    return { written, source };
  },
};
