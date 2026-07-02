import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, InfoSection } from '@haive/shared';
import { mapWithConcurrency } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { resolveParallelCap } from '../../_parallel-cap.js';
import { pathExists, resolveSkillTargetDirs } from './_helpers.js';

/** Fallback skills dir when no enabled CLI declares one — passed explicitly to
 *  resolveSkillTargetDirs so verification always has somewhere to look. */
const DEFAULT_PROJECT_SKILLS_DIR = '.claude/skills';

/** Generator step this verification re-runs when the user opts to regenerate
 *  broken/deficient skills (reviseLoop target). */
const SKILL_GENERATION_STEP_ID = '09_5-skill-generation';

/** Targeted-repair step this verification routes to when the user opts to repair only the
 *  failing skills (reviseLoop target — cheap alternative to a full 09_5 regeneration). */
const SKILL_REPAIR_STEP_ID = '09_5b-skill-repair';

/** Issue text recorded for a skill whose SKILL.md is valid but has no sub-skill
 *  leaf docs — the disk-side signal of a truncated 09_5 generation. Only added for
 *  NON-bundle skills (a user-supplied bundle skill may legitimately be flat). */
const SUBSKILL_DEFICIENCY_ISSUE = 'no sub-skills (likely truncated generation — re-run 09_5)';

function skillsDirParts(skillsDir: string): string[] {
  return skillsDir.split('/').filter((p) => p.length > 0);
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/** Repo-relative skill ids that came from custom bundles (06_3). They are
 *  user-supplied and may legitimately be flat (no sub-skills), so the sub-skill
 *  deficiency check skips them. Mirrors loadBundleSkills' query in 09_5. */
export async function loadBundleSkillIds(ctx: StepContext): Promise<Set<string>> {
  const out = new Set<string>();
  const taskRow = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repositoryId = taskRow[0]?.repositoryId ?? null;
  if (!repositoryId) return out;
  const items = await ctx.db
    .select({ normalizedSpec: schema.customBundleItems.normalizedSpec })
    .from(schema.customBundleItems)
    .innerJoin(schema.customBundles, eq(schema.customBundleItems.bundleId, schema.customBundles.id))
    .where(
      and(
        eq(schema.customBundles.repositoryId, repositoryId),
        eq(schema.customBundleItems.kind, 'skill'),
      ),
    );
  for (const item of items) {
    const spec = item.normalizedSpec as { id?: unknown } | null;
    if (spec && typeof spec.id === 'string' && spec.id.trim().length > 0) {
      out.add(spec.id.trim());
    }
  }
  return out;
}

export interface SkillCheck {
  skillId: string;
  /** Repo-relative skills dir (mirror) this check ran against. With multiple
   *  enabled CLIs the same skill is checked once per dir, so a mirror that
   *  diverged from the others surfaces as its own failing check. */
  skillsDir: string;
  skillPath: string;
  passed: boolean;
  issues: string[];
  /** Number of *.md files under the skill's sub-skills/ dir. 0 is the truncated-
   *  generation signal (a valid SKILL.md with no leaf docs). */
  subSkillCount: number;
}

export interface SkillVerificationDetect {
  checks: SkillCheck[];
  missingFileIds: string[];
  brokenStructureIds: string[];
  /** Skills whose SKILL.md exists and is readable but have zero sub-skill files —
   *  the disk-side signal of a truncated/partial 09_5 generation. */
  deficientSubSkillIds: string[];
  /** Every enabled provider's skills dir. Each skill is verified in ALL of them so
   *  a mirror that 09_5 failed to write (or that diverged) is caught, not just the
   *  active CLI's copy. */
  skillTargetDirs: string[];
  /** The user's enabled CLI providers, for the gate's optional "CLI for the fix"
   *  dropdown ({id, label}). 0–1 providers hides the dropdown (nothing to choose). */
  cliOptions: { id: string; label: string }[];
  /** The task's current/resolved provider (ctx.cliProviderId) — the dropdown's
   *  pre-selected default so leaving it unchanged keeps today's behavior. */
  currentCliId: string | null;
}

export interface SkillVerificationApply {
  checks: SkillCheck[];
  passed: boolean;
  /** The user's gate decision when issues were found: 'accept' ships the skills
   *  as-is, 'repair' re-runs only the failing skills via 09_5b, 'regenerate' re-runs
   *  the full 09_5. All routed via reviseLoop. 'none' when there were no issues and
   *  the form auto-skipped. */
  decision: 'none' | 'accept' | 'repair' | 'regenerate';
}

export interface ParsedSkill {
  name: string | null;
  description: string | null;
  hasTitle: boolean;
  hasOverviewSection: boolean;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const FOLDED_DESC_RE = /^description:\s*>\s*\n([\s\S]*?)(?=\n[A-Za-z][^\n]*:|\n*$)/m;

export function parseSkillMarkdown(text: string): ParsedSkill {
  const fm = text.match(FRONTMATTER_RE);
  let name: string | null = null;
  let description: string | null = null;
  if (fm && fm[1]) {
    const fmBody = fm[1];
    const nameMatch = fmBody.match(/^name:\s*(.+)$/m);
    if (nameMatch && nameMatch[1]) name = nameMatch[1].trim();
    const inlineDesc = fmBody.match(/^description:\s*(\S.*)$/m);
    if (inlineDesc && inlineDesc[1]) {
      description = inlineDesc[1].trim();
    } else {
      const folded = fmBody.match(FOLDED_DESC_RE);
      if (folded && folded[1]) {
        const lines = folded[1]
          .split('\n')
          .map((l) => l.replace(/^\s+/, ''))
          .filter((l) => l.length > 0);
        if (lines.length > 0) description = lines.join(' ');
      }
    }
  }
  return {
    name,
    description,
    hasTitle: /^#\s+\S/m.test(text),
    hasOverviewSection: /^##\s+Overview\b/m.test(text),
  };
}

export async function listSkillDirs(repo: string, skillsDir: string): Promise<string[]> {
  const root = path.join(repo, ...skillsDirParts(skillsDir));
  if (!(await pathExists(root))) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** List *.md leaf docs under <skillsDir>/<id>/sub-skills/. Returns [] when the dir
 *  is absent (→ the deficiency signal). Sorted for stable check ordering. */
async function listSubSkillFiles(
  repo: string,
  skillsDir: string,
  skillId: string,
): Promise<string[]> {
  const dir = path.join(repo, ...skillsDirParts(skillsDir), skillId, 'sub-skills');
  if (!(await pathExists(dir))) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Structural validation of a single sub-skill leaf doc against the invariants
 *  09_5's subSkillToMarkdown always emits: frontmatter name+description, an H1
 *  title, a `## Identification` block, and a non-empty body. Catches a present-but-
 *  truncated/empty/corrupt leaf file that listSubSkillFiles' count alone passes.
 *  Returns issue strings prefixed with the filename, empty when valid. */
async function checkSubSkillFile(filePath: string, fileName: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    return [`sub-skills/${fileName}: read failed: ${(err as Error).message}`];
  }
  if (text.trim().length === 0) return [`sub-skills/${fileName}: empty`];
  const issues: string[] = [];
  const parsed = parseSkillMarkdown(text);
  if (!parsed.name) issues.push(`sub-skills/${fileName}: frontmatter missing name`);
  if (!parsed.description) issues.push(`sub-skills/${fileName}: frontmatter missing description`);
  if (!parsed.hasTitle) issues.push(`sub-skills/${fileName}: missing level-1 title heading`);
  if (!/^##\s+Identification\b/m.test(text)) {
    issues.push(`sub-skills/${fileName}: missing ## Identification section`);
  }
  // Body floor: everything after the frontmatter (title + Identification + body)
  // must carry real content. A stub/truncated leaf collapses well under this; a
  // real 100-250 line sub-skill is far above it, so no false positives.
  const afterFrontmatter = text.replace(FRONTMATTER_RE, '').trim();
  if (afterFrontmatter.length < 80) {
    issues.push(`sub-skills/${fileName}: body is empty or truncated`);
  }
  return issues;
}

export async function checkSkill(
  repo: string,
  skillsDir: string,
  skillId: string,
  isBundle = false,
): Promise<SkillCheck> {
  const skillPath = path.join(repo, ...skillsDirParts(skillsDir), skillId, 'SKILL.md');
  if (!(await pathExists(skillPath))) {
    return {
      skillId,
      skillsDir,
      skillPath,
      passed: false,
      issues: ['SKILL.md missing'],
      subSkillCount: 0,
    };
  }
  let text: string;
  try {
    text = await readFile(skillPath, 'utf8');
  } catch (err) {
    return {
      skillId,
      skillsDir,
      skillPath,
      passed: false,
      issues: [`read failed: ${(err as Error).message}`],
      subSkillCount: 0,
    };
  }
  if (text.trim().length === 0) {
    return {
      skillId,
      skillsDir,
      skillPath,
      passed: false,
      issues: ['SKILL.md empty'],
      subSkillCount: 0,
    };
  }
  const issues: string[] = [];
  const parsed = parseSkillMarkdown(text);
  if (!parsed.name) issues.push('frontmatter missing name');
  if (!parsed.description) issues.push('frontmatter missing description');
  if (!parsed.hasTitle) issues.push('missing level-1 title heading');
  if (!parsed.hasOverviewSection) issues.push('missing ## Overview section');

  const subSkillFiles = await listSubSkillFiles(repo, skillsDir, skillId);
  const subSkillCount = subSkillFiles.length;
  // Bundle skills are user-supplied and may legitimately be flat — only flag a
  // missing sub-skills set for skills 09_5 was meant to generate.
  if (subSkillCount === 0 && !isBundle) {
    issues.push(SUBSKILL_DEFICIENCY_ISSUE);
  }
  // Validate the leaf docs themselves. Sequential (a skill carries 3-8 sub-skills,
  // trivial I/O) so we don't nest a concurrency fan-out inside detect's per-skill one.
  for (const name of subSkillFiles) {
    const subPath = path.join(repo, ...skillsDirParts(skillsDir), skillId, 'sub-skills', name);
    issues.push(...(await checkSubSkillFile(subPath, name)));
  }

  return {
    skillId,
    skillsDir,
    skillPath,
    passed: issues.length === 0,
    issues,
    subSkillCount,
  };
}

/** Provider the fix should run on, or null for "no change / not applicable". Pure so the
 *  gate → target-step routing is unit-tested without a DB. Only a repair/regenerate whose
 *  chosen provider is enabled AND differs from the current model records a preference;
 *  anything else leaves the current model (no spurious sticky write). */
export interface GateCliChoice {
  targetStepId: string;
  cliProviderId: string;
}

export function resolveGateCliChoice(args: {
  decision: SkillVerificationApply['decision'];
  repairCli: string | undefined;
  currentCliId: string | null;
  enabledIds: string[];
}): GateCliChoice | null {
  const { decision, repairCli, currentCliId, enabledIds } = args;
  if (decision !== 'repair' && decision !== 'regenerate') return null;
  if (!repairCli || repairCli === currentCliId) return null;
  if (!enabledIds.includes(repairCli)) return null;
  return {
    targetStepId: decision === 'repair' ? SKILL_REPAIR_STEP_ID : SKILL_GENERATION_STEP_ID,
    cliProviderId: repairCli,
  };
}

export const skillVerificationStep: StepDefinition<
  SkillVerificationDetect,
  SkillVerificationApply
> = {
  metadata: {
    id: '09_6-skill-verification',
    workflowType: 'onboarding',
    index: 12,
    title: 'Skill verification',
    description:
      'Walks every enabled CLI’s project skills directory, verifies each SKILL.md and its sub-skill leaf docs have the expected frontmatter and structure, and offers to re-run skill generation when any skill is missing, broken, or under-generated.',
    requiresCli: true,
    providerSensitive: true,
  },

  async detect(ctx: StepContext): Promise<SkillVerificationDetect> {
    const skillTargetDirs = await resolveSkillTargetDirs(ctx.db, ctx.userId, [
      DEFAULT_PROJECT_SKILLS_DIR,
    ]);
    const bundleSkillIds = await loadBundleSkillIds(ctx);
    const cap = await resolveParallelCap();

    // Union of skill ids across every mirror, so a skill present in one dir but
    // absent from another is verified (and flagged missing) in the dir it's gone from.
    const idsByDir = await mapWithConcurrency(skillTargetDirs, cap, (dir) =>
      listSkillDirs(ctx.repoPath, dir),
    );
    const allIds = dedupe(idsByDir.flat()).sort();

    const pairs: { dir: string; id: string }[] = [];
    for (const dir of skillTargetDirs) {
      for (const id of allIds) pairs.push({ dir, id });
    }
    const checks = await mapWithConcurrency(pairs, cap, ({ dir, id }) =>
      checkSkill(ctx.repoPath, dir, id, bundleSkillIds.has(id)),
    );

    const missingFileIds = dedupe(
      checks.filter((c) => c.issues.includes('SKILL.md missing')).map((c) => c.skillId),
    );
    const brokenStructureIds = dedupe(
      checks
        .filter((c) => !c.passed && !c.issues.includes('SKILL.md missing'))
        .map((c) => c.skillId),
    );
    // SKILL.md present and readable but no sub-skills on disk — the truncated/partial
    // 09_5 case. Keys on the deficiency issue, which checkSkill only adds for
    // non-bundle skills, so user-supplied flat bundle skills are excluded.
    const deficientSubSkillIds = dedupe(
      checks.filter((c) => c.issues.includes(SUBSKILL_DEFICIENCY_ISSUE)).map((c) => c.skillId),
    );
    ctx.logger.info(
      {
        targetDirs: skillTargetDirs,
        total: checks.length,
        passed: checks.filter((c) => c.passed).length,
        missing: missingFileIds.length,
        broken: brokenStructureIds.length,
        deficientSubSkills: deficientSubSkillIds.length,
      },
      'skill verification detect complete',
    );
    // Enabled CLI providers for the gate's optional "CLI for the fix" dropdown. The
    // chosen provider is recorded (in apply) as the target step's preference so the
    // forked repair/regenerate round runs on it. Mirrors 12-post-onboarding's enumeration.
    const providerRows = await ctx.db.query.cliProviders.findMany({
      where: and(eq(schema.cliProviders.userId, ctx.userId), eq(schema.cliProviders.enabled, true)),
      columns: { id: true, label: true },
    });
    const cliOptions = providerRows.map((p) => ({ id: p.id, label: p.label }));

    return {
      checks,
      missingFileIds,
      brokenStructureIds,
      deficientSubSkillIds,
      skillTargetDirs,
      cliOptions,
      currentCliId: ctx.cliProviderId,
    };
  },

  // No issues → null form → the step auto-advances (clean libraries never gate).
  // Issues → a human review gate listing them: Accept ships as-is, Regenerate routes
  // back to 09_5 (reviseLoop below). 'accept' is the default so an auto-continue task
  // finalizes by default and the uncapped revise route is never auto-selected.
  form(_ctx, detected): FormSchema | null {
    const failing = detected.checks.filter((c) => !c.passed);
    if (failing.length === 0) return null;

    const body = failing
      .map((c) => `- \`${c.skillsDir}/${c.skillId}\` — ${c.issues.join('; ')}`)
      .join('\n');
    const infoSections: InfoSection[] = [
      {
        title: `${failing.length} skill issue(s) found`,
        preview: [
          detected.missingFileIds.length > 0 ? `${detected.missingFileIds.length} missing` : '',
          detected.brokenStructureIds.length > 0
            ? `${detected.brokenStructureIds.length} broken`
            : '',
        ]
          .filter(Boolean)
          .join(', '),
        body,
        defaultOpen: true,
      },
    ];
    // Decision radio + an optional "CLI for the fix" picker shown only for the two fix
    // routes (visibleWhen decision != accept). Offered only when the user has more than one
    // enabled provider — with 0–1 there is nothing to choose.
    const fields: FormSchema['fields'] = [
      {
        type: 'radio',
        id: 'decision',
        label: 'How should these skill issues be handled?',
        options: [
          { value: 'accept', label: 'Accept as-is — keep the skills despite the issues' },
          { value: 'repair', label: 'Repair — re-run only the failing skills (fast)' },
          { value: 'regenerate', label: 'Regenerate — re-run the full skill library (slow)' },
        ],
        default: 'accept',
        required: true,
      },
    ];
    if (detected.cliOptions.length > 1) {
      const options = detected.cliOptions.map((o) => ({ value: o.id, label: o.label }));
      const hasCurrent =
        detected.currentCliId !== null && options.some((o) => o.value === detected.currentCliId);
      fields.push({
        type: 'select',
        id: 'repairCli',
        label: 'CLI for the fix',
        description:
          'Which CLI/model runs the repair or regeneration. Defaults to the task’s current model.',
        options,
        default: hasCurrent ? (detected.currentCliId as string) : undefined,
        visibleWhen: { field: 'decision', notEquals: 'accept' },
      });
    }
    return {
      title: 'Skill verification found issues',
      description: [
        'One or more generated skills are missing, structurally broken, or have no',
        'sub-skill leaf docs. Accept them as-is, repair only the failing skills (one agent',
        'each — fast), or regenerate the whole library (slow). Either fix comes back here',
        'for another check.',
      ].join(' '),
      infoSections,
      fields,
      submitLabel: 'Apply decision',
    };
  },

  // Repair routes to 09_5b (fixes only the failing skills); Regenerate re-enters 09_5 (full
  // re-run). Both fork a new round and come back through this step for another verification.
  // Accept / no-issues returns null and the step finalizes. Human-gated and uncapped — the
  // user breaks the cycle by choosing Accept.
  reviseLoop: {
    evaluate: (out) =>
      out.decision === 'repair'
        ? { targetStepId: SKILL_REPAIR_STEP_ID }
        : out.decision === 'regenerate'
          ? { targetStepId: SKILL_GENERATION_STEP_ID }
          : null,
  },

  async apply(ctx, args): Promise<SkillVerificationApply> {
    const detected = args.detected as SkillVerificationDetect;
    const values = args.formValues as { decision?: string; repairCli?: string };
    const passed = detected.checks.every((c) => c.passed);
    const decision: SkillVerificationApply['decision'] = passed
      ? 'none'
      : values.decision === 'regenerate'
        ? 'regenerate'
        : values.decision === 'repair'
          ? 'repair'
          : 'accept';

    // When the user picked a CLI for the fix, record it as the target step's per-step
    // preference so the forked repair (09_5b) / regenerate (09_5) round dispatches on it.
    // Mirrors the per-step CLI picker's write (userStepCliPreferences + a touched marker);
    // resolvePreferredCli reads it at dispatch. Only a real change from the current model is
    // written, so an unchanged dropdown never mints a sticky preference.
    const cliChoice = resolveGateCliChoice({
      decision,
      repairCli: typeof values.repairCli === 'string' ? values.repairCli : undefined,
      currentCliId: detected.currentCliId,
      enabledIds: detected.cliOptions.map((o) => o.id),
    });
    if (cliChoice) {
      await ctx.db
        .insert(schema.userStepCliPreferences)
        .values({
          userId: ctx.userId,
          stepId: cliChoice.targetStepId,
          cliProviderId: cliChoice.cliProviderId,
          explicit: true,
        })
        .onConflictDoUpdate({
          target: [schema.userStepCliPreferences.userId, schema.userStepCliPreferences.stepId],
          set: { cliProviderId: cliChoice.cliProviderId, explicit: true, updatedAt: new Date() },
        });
      await ctx.db
        .insert(schema.taskStepCliTouched)
        .values({ taskId: ctx.taskId, stepId: cliChoice.targetStepId, role: 'default' })
        .onConflictDoNothing();
    }

    ctx.logger.info(
      {
        passed,
        decision,
        missing: detected.missingFileIds.length,
        broken: detected.brokenStructureIds.length,
        fixCli: cliChoice?.cliProviderId ?? null,
        fixCliStep: cliChoice?.targetStepId ?? null,
      },
      'skill verification apply complete',
    );
    return { checks: detected.checks, passed, decision };
  },
};
