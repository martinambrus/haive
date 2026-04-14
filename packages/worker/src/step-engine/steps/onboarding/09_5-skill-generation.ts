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

interface SkillEntry {
  id: string;
  title: string;
  description: string;
  instructions: string;
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
  if (typeof v.id !== 'string') return false;
  if (typeof v.title !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  if (typeof v.instructions !== 'string') return false;
  if (v.usage !== undefined && typeof v.usage !== 'string') return false;
  return true;
}

function skillToMarkdown(entry: SkillEntry): string {
  const fm = ['---', `name: ${entry.id}`, `description: ${entry.description}`, '---', ''].join(
    '\n',
  );
  const body = [
    `# ${entry.title}`,
    '',
    '## Description',
    '',
    entry.description,
    '',
    '## Instructions',
    '',
    entry.instructions.trim(),
    '',
  ];
  if (entry.usage) {
    body.push('## Usage');
    body.push('');
    body.push(entry.usage.trim());
    body.push('');
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
      kbPreview = text.trim().slice(0, 800);
    } catch {
      kbPreview = '';
    }
  }
  const fm = [
    '---',
    `name: ${candidate.id}`,
    `description: ${candidate.label} (stub — fill in human-written description)`,
    '---',
    '',
  ].join('\n');
  const lines = [
    `# ${candidate.label}`,
    '',
    '## Description',
    '',
    `${candidate.label} stub generated without LLM synthesis. Fill in a concrete description before using.`,
    '',
    '## Instructions',
    '',
    'LLM synthesis was skipped. Replace this section with the actual skill instructions.',
    '',
    `Hint: ${candidate.hint}`,
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
        'You are generating Claude Code skill entries for an engineering onboarding workflow.',
        'For each skill below, emit ONE JSON object inside a ```json fenced code block.',
        'Every JSON object must have the exact shape:',
        '{',
        '  "id": "<skill id>",',
        '  "title": "<skill title>",',
        '  "description": "<one sentence activation description>",',
        '  "instructions": "<multi-paragraph skill body, markdown>",',
        '  "usage": "<optional usage examples, markdown>"',
        '}',
        'Do not emit any prose outside the fenced blocks. Ground the instructions in the corresponding knowledge base file when available.',
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
