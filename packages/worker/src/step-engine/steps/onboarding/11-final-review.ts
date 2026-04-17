import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from './_helpers.js';

interface ReviewFinding {
  id: string;
  severity: 'info' | 'warn' | 'error';
  label: string;
  detail: string;
}

interface FinalReviewDetect {
  findings: ReviewFinding[];
  counts: {
    knowledgeBase: number;
    skills: number;
    agents: number;
    commands: number;
  };
}

interface FinalReviewApply {
  acknowledged: boolean;
  reviewPath: string;
  source: 'llm' | 'template';
}

async function countFiles(dir: string, predicate: (name: string) => boolean): Promise<number> {
  if (!(await pathExists(dir))) return 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && predicate(e.name)).length;
  } catch {
    return 0;
  }
}

async function countSkillDirs(skillsRoot: string): Promise<number> {
  if (!(await pathExists(skillsRoot))) return 0;
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    let n = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillFile = path.join(skillsRoot, e.name, 'SKILL.md');
      if (await pathExists(skillFile)) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

export async function collectReviewFindings(repo: string): Promise<FinalReviewDetect> {
  const kbDir = path.join(repo, '.claude', 'knowledge_base');
  const skillsDir = path.join(repo, '.claude', 'skills');
  const agentsDir = path.join(repo, '.claude', 'agents');
  const commandsDir = path.join(repo, '.claude', 'commands');

  const [knowledgeBase, skills, agents, commands] = await Promise.all([
    countFiles(kbDir, (n) => n.endsWith('.md')),
    countSkillDirs(skillsDir),
    countFiles(agentsDir, (n) => n.endsWith('.md')),
    countFiles(commandsDir, (n) => n.endsWith('.md')),
  ]);
  const findings: ReviewFinding[] = [];
  if (knowledgeBase === 0) {
    findings.push({
      id: 'empty-knowledge-base',
      severity: 'warn',
      label: 'Knowledge base is empty',
      detail: 'No .claude/knowledge_base/*.md files were produced.',
    });
  }
  if (skills === 0) {
    findings.push({
      id: 'no-skills',
      severity: 'warn',
      label: 'No skills generated',
      detail: 'No .claude/skills/*/SKILL.md files were produced.',
    });
  }
  if (agents === 0) {
    findings.push({
      id: 'no-agents',
      severity: 'info',
      label: 'No subagent files',
      detail:
        'No .claude/agents/*.md files were produced; agent discovery step may not be ported yet.',
    });
  }
  if (commands === 0) {
    findings.push({
      id: 'no-commands',
      severity: 'info',
      label: 'No slash commands',
      detail: 'No .claude/commands/*.md files were produced.',
    });
  }
  if (findings.length === 0) {
    findings.push({
      id: 'ok',
      severity: 'info',
      label: 'Onboarding output looks complete',
      detail: 'All expected onboarding artefacts were produced.',
    });
  }

  return {
    findings,
    counts: { knowledgeBase, skills, agents, commands },
  };
}

function defaultReviewMarkdown(detected: FinalReviewDetect, notes: string): string {
  const lines: string[] = [
    '# Onboarding final review',
    '',
    '## Artefact counts',
    '',
    `- Knowledge base entries: ${detected.counts.knowledgeBase}`,
    `- Skills: ${detected.counts.skills}`,
    `- Agents: ${detected.counts.agents}`,
    `- Commands: ${detected.counts.commands}`,
    '',
    '## Findings',
    '',
  ];
  for (const f of detected.findings) {
    lines.push(`- **[${f.severity}]** ${f.label} — ${f.detail}`);
  }
  if (notes.trim().length > 0) {
    lines.push('');
    lines.push('## Reviewer notes');
    lines.push('');
    lines.push(notes.trim());
  }
  lines.push('');
  return lines.join('\n');
}

function llmReviewMarkdown(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const fenceMatch = /```(?:markdown|md)?\s*([\s\S]*?)```/.exec(raw);
  const inner = fenceMatch?.[1];
  const body = (inner ?? raw).trim();
  if (body.length === 0) return fallback;
  if (body.startsWith('#')) return `${body}\n`;
  return `# Onboarding final review\n\n${body}\n`;
}

export const finalReviewStep: StepDefinition<FinalReviewDetect, FinalReviewApply> = {
  metadata: {
    id: '11-final-review',
    workflowType: 'onboarding',
    index: 15,
    title: 'Final review',
    description:
      'Summarises everything produced by the onboarding workflow, flags missing artefacts, and writes .claude/onboarding-review.md for the user to read before the post-onboarding step.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<FinalReviewDetect> {
    const detect = await collectReviewFindings(ctx.repoPath);
    ctx.logger.info(
      { counts: detect.counts, findings: detect.findings.length },
      'final review collected',
    );
    return detect;
  },

  form(_ctx, detected): FormSchema {
    const summary = [
      `Knowledge base entries: ${detected.counts.knowledgeBase}`,
      `Skills: ${detected.counts.skills}`,
      `Agents: ${detected.counts.agents}`,
      `Commands: ${detected.counts.commands}`,
      '',
      'Findings:',
      ...detected.findings.map((f) => `- [${f.severity}] ${f.label}`),
    ].join('\n');
    return {
      title: 'Final review',
      description: summary,
      fields: [
        {
          type: 'checkbox',
          id: 'acknowledged',
          label: 'Confirm',
          default: false,
          required: true,
        },
        {
          type: 'textarea',
          id: 'reviewerNotes',
          label: 'Optional reviewer notes',
          rows: 4,
        },
      ],
      submitLabel: 'Record review',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt: (args) => {
      const detected = args.detected as FinalReviewDetect;
      const values = args.formValues as { reviewerNotes?: string };
      return [
        'You are writing a concise onboarding review summary for an engineering project.',
        'Produce a single Markdown block starting with `# Onboarding final review`.',
        'Include an "Artefact counts" section and a "Findings" section grounded in the data below.',
        'Do not invent artefacts. Keep it under 400 words.',
        '',
        `Counts: ${JSON.stringify(detected.counts)}`,
        `Findings: ${JSON.stringify(detected.findings)}`,
        `Reviewer notes: ${values.reviewerNotes ?? ''}`,
      ].join('\n');
    },
    timeoutMs: 15 * 60 * 1000,
  },

  async apply(ctx, args): Promise<FinalReviewApply> {
    const detected = args.detected as FinalReviewDetect;
    const values = args.formValues as {
      acknowledged?: boolean;
      reviewerNotes?: string;
    };
    const notes = values.reviewerNotes ?? '';
    const fallback = defaultReviewMarkdown(detected, notes);
    const markdown =
      args.llmOutput != null ? llmReviewMarkdown(args.llmOutput, fallback) : fallback;
    const claudeDir = path.join(ctx.repoPath, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const reviewPath = path.join(claudeDir, 'onboarding-review.md');
    await writeFile(reviewPath, markdown, 'utf8');
    const source: 'llm' | 'template' = args.llmOutput != null ? 'llm' : 'template';
    ctx.logger.info(
      { reviewPath, source, acknowledged: !!values.acknowledged },
      'final review written',
    );
    return {
      acknowledged: !!values.acknowledged,
      reviewPath,
      source,
    };
  },
};
