import path from 'node:path';
import { lstatNoFollow, readdirNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName, FormSchema } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import type { StepContext, StepDefinition } from '../../step-definition.js';

interface ActiveAgentsTarget {
  dir: string;
  ext: '.md' | '.toml';
}

async function resolveActiveAgentsTarget(ctx: StepContext): Promise<ActiveAgentsTarget | null> {
  const defaultTarget: ActiveAgentsTarget = { dir: '.claude/agents', ext: '.md' };
  if (!ctx.cliProviderId) return defaultTarget;
  const row = await ctx.db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, ctx.cliProviderId),
    columns: { name: true },
  });
  if (!row) return defaultTarget;
  const meta = getCliProviderMetadata(row.name as CliProviderName);
  if (!meta.projectAgentsDir || !meta.agentFileFormat) return null;
  return {
    dir: meta.projectAgentsDir,
    ext: meta.agentFileFormat === 'toml' ? '.toml' : '.md',
  };
}

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
  };
}

interface FinalReviewApply {
  acknowledged: boolean;
  reviewPath: string;
  source: 'llm' | 'template';
}

async function countFiles(
  anchor: string,
  relDir: string,
  predicate: (name: string) => boolean,
): Promise<number> {
  // null is absence, or a directory reached through a link. Both mean nothing is installed here,
  // which is what the `pathExists` probe and the `catch` around the read used to say in two steps.
  const entries = await readdirNoFollow(anchor, relDir);
  if (entries === null) return 0;
  return entries.filter((e) => e.isFile() && predicate(e.name)).length;
}

async function countSkillDirs(anchor: string, relDir: string): Promise<number> {
  const entries = await readdirNoFollow(anchor, relDir);
  if (entries === null) return 0;
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // A skill counts only when its SKILL.md is a REGULAR FILE. `pathExists` is `stat`-based, so it
    // followed a link — counting a skill whose definition lives wherever that link pointed.
    const info = await lstatNoFollow(anchor, `${relDir}/${e.name}/SKILL.md`);
    if (info?.kind === 'file') n += 1;
  }
  return n;
}

export async function collectReviewFindings(
  repo: string,
  activeAgentsTarget: ActiveAgentsTarget | null = { dir: '.claude/agents', ext: '.md' },
): Promise<FinalReviewDetect> {
  const agentsRel = activeAgentsTarget?.dir ?? null;
  const agentExt = activeAgentsTarget?.ext ?? '.md';

  const [knowledgeBase, skills, agents] = await Promise.all([
    countFiles(repo, KB_DIR, (n) => n.endsWith('.md')),
    countSkillDirs(repo, '.claude/skills'),
    agentsRel ? countFiles(repo, agentsRel, (n) => n.endsWith(agentExt)) : Promise.resolve(0),
  ]);
  const findings: ReviewFinding[] = [];
  if (knowledgeBase === 0) {
    findings.push({
      id: 'empty-knowledge-base',
      severity: 'warn',
      label: 'Knowledge base is empty',
      detail: `No ${KB_DIR}/*.md files were produced.`,
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
  if (activeAgentsTarget === null) {
    findings.push({
      id: 'agents-not-applicable',
      severity: 'info',
      label: 'Active CLI has no file-based agents',
      detail: 'The active CLI (amp) uses only the built-in Task tool; no agent files expected.',
    });
  } else if (agents === 0) {
    findings.push({
      id: 'no-agents',
      severity: 'info',
      label: 'No subagent files',
      detail: `No ${activeAgentsTarget.dir}/*${agentExt} files were produced; agent discovery step may not be ported yet.`,
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
    counts: { knowledgeBase, skills, agents },
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

function stripOuterFence(raw: string): string {
  // Unwrap only when the ENTIRE payload is one fenced block, closed by a run at least as long as its
  // opener: the scanner cannot, since a model's wrapper holds inner ``` samples that close it early.
  const trimmed = raw.trim();
  const open = /^(`{3,}|~{3,})(?:markdown|md)?[ \t]*\n/.exec(trimmed);
  if (!open) return trimmed;
  const run = open[1]!;
  const close = new RegExp(`${run[0]}{${run.length},}$`).exec(trimmed.slice(open[0].length));
  if (!close) return trimmed;
  return trimmed.slice(open[0].length, trimmed.length - close[0].length).trim();
}

export function llmReviewMarkdown(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const body = stripOuterFence(raw);
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
    providerSensitive: true,
  },

  async detect(ctx: StepContext): Promise<FinalReviewDetect> {
    const agentsTarget = await resolveActiveAgentsTarget(ctx);
    const detect = await collectReviewFindings(ctx.repoPath, agentsTarget);
    ctx.logger.info(
      { counts: detect.counts, findings: detect.findings.length, agentsTarget },
      'final review collected',
    );
    return detect;
  },

  form(_ctx, detected): FormSchema {
    const summary = [
      `Knowledge base entries: ${detected.counts.knowledgeBase}`,
      `Skills: ${detected.counts.skills}`,
      `Agents: ${detected.counts.agents}`,
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
    const reviewRel = '.claude/onboarding-review.md';
    await writeFileNoFollow(ctx.repoPath, reviewRel, markdown, { createParents: true });
    const reviewPath = path.join(ctx.repoPath, reviewRel);
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
