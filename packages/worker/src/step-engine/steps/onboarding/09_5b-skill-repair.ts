import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DetectResult, SkillEntry } from '@haive/shared';
import { mapWithConcurrency } from '@haive/shared';
import type { KbFileSummary } from './09-qa.js';
import type { AgentMiningDispatch, StepContext, StepDefinition } from '../../step-definition.js';
import { resolveParallelCap } from '../../_parallel-cap.js';
import { loadPreviousStepOutput, pathExists, resolveSkillTargetDirs } from './_helpers.js';
import { buildSkillContractBlocks } from './_skill-prompt.js';
import {
  loadMiningScopeExcludeGlobs,
  noSubagentInstructionLines,
  scopeInstructionLines,
} from './_scope.js';
import {
  collectShortFileTree,
  hasSubSkills,
  listKbFiles,
  parseSkillEntries,
  sanitizeSkillId,
  sanitizeSubSkills,
  skillsReadmeMarkdown,
  skillToMarkdown,
  subSkillToMarkdown,
} from './09_5-skill-generation.js';
import {
  checkSkill,
  listSkillDirs,
  loadBundleSkillIds,
  parseSkillMarkdown,
} from './09_6-skill-verification.js';

const DEFAULT_PROJECT_SKILLS_DIR = '.claude/skills';
const STEP_ID = '09_5b-skill-repair';

/** task_event the revise handler appends when a review step routes to an earlier step
 *  (task-queue.ts, the `revise` case). Its payload carries `{ targetStepId, round }` — the
 *  routing decision IS the run signal, so shouldRun matches on it instead of maintaining a
 *  separate requested/consumed marker (which could desync if apply throws). */
const STEP_REVISE_EVENT = 'step.revise';

/** One repair agent's request. `maxSub`/`bodyLen` reuse 09_5's non-truncation mandate — a
 *  single skill's JSON is exactly one 09_5 loop-pass worth of output, which already fits the
 *  model's ceiling, so no shrink is needed. */
const REPAIR_MAX_SUB = 8;
const REPAIR_BODY_LEN = '100-250';

interface FailingSkill {
  skillId: string;
  /** Union of verification issues across every mirror dir the skill failed in. */
  issues: string[];
  /** First ~2000 chars of the current (broken) SKILL.md, or null when it is missing/
   *  unreadable. Handed to the agent so a structural fix can preserve the correct parts. */
  skillMdExcerpt: string | null;
}

interface SkillRepairDetect {
  failingSkills: FailingSkill[];
  /** Every enabled provider's skills dir; a repaired skill is rewritten into ALL of them so
   *  divergent mirrors converge (a skill can fail in one mirror and pass in another). */
  skillTargetDirs: string[];
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  /** Transient file tree for agent orientation; mirrors 09_5's __fileTree. */
  __fileTree?: string;
  /** Transient per-task mining deny list; drives the hard-scope prompt section. */
  __scopeExclude?: string[];
}

interface SkillRepairApply {
  /** Skill ids that produced a valid corrected skill and were rewritten. */
  repaired: string[];
  /** Failing skill ids whose agent returned nothing usable — left on disk as-is so 09_6
   *  re-surfaces them (the user can repair again, accept, or regenerate). */
  stillFailing: string[];
  /** Total failing skills this pass attempted to repair. */
  attempted: number;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

function formatKbList(kbFiles: KbFileSummary[]): string {
  if (kbFiles.length === 0) return '(no knowledge base files yet)';
  return kbFiles
    .map(
      (f) =>
        `- ${f.relPath} — ${f.title}` +
        (f.sectionHeadings.length > 0
          ? `\n    sections: ${f.sectionHeadings.slice(0, 8).join('; ')}`
          : ''),
    )
    .join('\n');
}

/** Build one failing skill's repair prompt. Reuses the shared JSON contract blocks
 *  (buildSkillContractBlocks) so the emitted shape is identical to generation; the framing
 *  differs — the agent is CORRECTING a named, existing skill, not discovering a new one, so
 *  the id is pinned and the empty-array "done" escape is explicitly forbidden. */
function buildSkillRepairPrompt(opts: {
  skillId: string;
  issues: string[];
  skillMdExcerpt: string | null;
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  fileTree: string;
  scopeExclude: string[];
  skillsDir: string;
}): string {
  const issuesBlock = opts.issues.map((i) => `- ${i}`).join('\n');
  const existingBlock = opts.skillMdExcerpt
    ? [
        '## Current (broken) SKILL.md',
        '',
        'This is what is on disk now. Keep the parts that are correct, fix every issue above,',
        'and regenerate any missing sub-skills so the required structure below is fully satisfied.',
        '',
        '```markdown',
        opts.skillMdExcerpt,
        '```',
        '',
      ].join('\n')
    : 'The SKILL.md is missing or unreadable — regenerate the whole skill from scratch for this capability.\n';

  return [
    'You are a senior software engineer REPAIRING one existing Claude Code SKILL for this',
    'specific codebase. The skill failed automated verification and must be corrected.',
    '',
    `## Skill to repair: \`${opts.skillId}\``,
    '',
    `Keep this id EXACTLY — it is the on-disk directory name under \`${opts.skillsDir}/\`. Do NOT rename it`,
    'and do NOT produce a skill for any other capability.',
    '',
    '## Verification failures to fix',
    '',
    issuesBlock,
    '',
    existingBlock,
    '## Project context',
    '',
    `Framework: ${opts.framework ?? 'unknown'}`,
    `Language: ${opts.language ?? 'unknown'}`,
    '',
    '## Existing knowledge base (consult these for domain understanding)',
    '',
    formatKbList(opts.kbFiles),
    '',
    '## Repository overview (partial file tree)',
    '',
    '```',
    opts.fileTree || '(no file tree available)',
    '```',
    '',
    ...scopeInstructionLines(opts.scopeExclude),
    ...noSubagentInstructionLines(),
    '## Your task',
    '',
    'Use your read-only tools (Read, Grep, Glob, Bash for read-only commands) to explore the',
    `in-scope directories for the \`${opts.skillId}\` capability, then emit a corrected, COMPLETE skill as JSON.`,
    'You MUST return the corrected skill (a `skills` array of length 1). Do NOT return an empty',
    'array — this is a repair, the skill is required.',
    '',
    ...buildSkillContractBlocks(REPAIR_MAX_SUB, REPAIR_BODY_LEN),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* README rebuild                                                      */
/* ------------------------------------------------------------------ */

/** Read every skill dir under `dir` and return {id, description} for the README index.
 *  `skillsReadmeMarkdown` only renders id + description in the table, so title is passed as
 *  the id (unused). Keeps the index consistent after a repair rewrites descriptions. */
async function readDiskSkillSummaries(
  repoPath: string,
  dir: string,
): Promise<{ id: string; title: string; description: string }[]> {
  const ids = await listSkillDirs(repoPath, dir);
  const parts = dir.split('/').filter((p) => p.length > 0);
  const out: { id: string; title: string; description: string }[] = [];
  for (const id of ids) {
    const skillMd = path.join(repoPath, ...parts, id, 'SKILL.md');
    if (!(await pathExists(skillMd))) continue;
    let text: string;
    try {
      text = await readFile(skillMd, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(text);
    out.push({ id, title: id, description: parsed.description ?? id });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const skillRepairStep: StepDefinition<SkillRepairDetect, SkillRepairApply> = {
  metadata: {
    id: STEP_ID,
    workflowType: 'onboarding',
    index: 11.5,
    title: 'Skill repair',
    description:
      'Re-runs only the skills that failed verification: one repair agent per failing skill regenerates a corrected SKILL.md and its sub-skills, then hands back to verification — without re-running the full skill-generation step.',
    requiresCli: true,
    providerSensitive: true,
    // Same corruption risk as 09_5: a weak local model can produce a malformed skill.
    unsafeForLocalModels: true,
  },

  // Gate: run ONLY when 09_6 routed here via reviseLoop for THIS round. The revise handler
  // forks a new round (target != source) and appends a `step.revise` event stamped with the
  // target step id + forked round BEFORE enqueuing this step, so matching that event is the
  // signal. On the round-0 forward pass (right after 09_5) no such event exists → skipped, so
  // the step never auto-repairs; the `regenerate` route stamps 09_5's id, never matching here.
  async shouldRun(ctx: StepContext): Promise<boolean> {
    if (ctx.round <= 0) return false;
    const rows = await ctx.db
      .select({ payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, ctx.taskId),
          eq(schema.taskEvents.eventType, STEP_REVISE_EVENT),
        ),
      );
    return rows.some((r) => {
      const p = r.payload as { targetStepId?: string; round?: number } | null;
      return p?.targetStepId === STEP_ID && p?.round === ctx.round;
    });
  },

  async detect(ctx: StepContext): Promise<SkillRepairDetect> {
    const skillTargetDirs = await resolveSkillTargetDirs(ctx.db, ctx.userId, [
      DEFAULT_PROJECT_SKILLS_DIR,
    ]);
    const bundleSkillIds = await loadBundleSkillIds(ctx);
    const cap = await resolveParallelCap();

    // Re-scan disk (ground truth) with 09_6's own per-skill checker across every mirror, so
    // the failing set is exactly what verification would compute — independent of any step row.
    const idsByDir = await mapWithConcurrency(skillTargetDirs, cap, (dir) =>
      listSkillDirs(ctx.repoPath, dir),
    );
    const allIds = Array.from(new Set(idsByDir.flat())).sort();
    const pairs: { dir: string; id: string }[] = [];
    for (const dir of skillTargetDirs) {
      for (const id of allIds) pairs.push({ dir, id });
    }
    const checks = await mapWithConcurrency(pairs, cap, ({ dir, id }) =>
      checkSkill(ctx.repoPath, dir, id, bundleSkillIds.has(id)),
    );

    // Aggregate failing checks by skillId, unioning issues across mirror dirs.
    const failingMap = new Map<string, Set<string>>();
    for (const c of checks) {
      if (c.passed) continue;
      const set = failingMap.get(c.skillId) ?? new Set<string>();
      for (const issue of c.issues) set.add(issue);
      failingMap.set(c.skillId, set);
    }

    const failingSkills: FailingSkill[] = [];
    for (const [skillId, issueSet] of failingMap) {
      let excerpt: string | null = null;
      for (const dir of skillTargetDirs) {
        const parts = dir.split('/').filter((p) => p.length > 0);
        const skillMd = path.join(ctx.repoPath, ...parts, skillId, 'SKILL.md');
        if (await pathExists(skillMd)) {
          try {
            const text = await readFile(skillMd, 'utf8');
            excerpt = text.length > 2000 ? text.slice(0, 2000) : text;
          } catch {
            excerpt = null;
          }
          if (excerpt) break;
        }
      }
      failingSkills.push({ skillId, issues: Array.from(issueSet), skillMdExcerpt: excerpt });
    }
    failingSkills.sort((a, b) => a.skillId.localeCompare(b.skillId));

    // Generation context for grounding (same sources as 09_5.detect). loadPreviousStepOutput
    // returns the latest round, so 01-env-detect (round 0) resolves on this forked round.
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;
    const kbFiles = await listKbFiles(ctx.repoPath);
    const scopeExclude = await loadMiningScopeExcludeGlobs(ctx.db, ctx.taskId);
    const fileTree =
      failingSkills.length > 0 ? await collectShortFileTree(ctx.repoPath, scopeExclude) : '';

    ctx.logger.info(
      { targetDirs: skillTargetDirs, failing: failingSkills.length },
      'skill repair detect complete',
    );
    return {
      failingSkills,
      skillTargetDirs,
      framework,
      language,
      kbFiles,
      __fileTree: fileTree,
      __scopeExclude: scopeExclude,
    };
  },

  // One repair agent per failing skill (parallel, capped by the runner). agentId = skillId so
  // apply maps each result straight back to its target dir. Empty on a clean disk or under
  // test bypass → no dispatch, apply no-ops.
  agentMining: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 60 * 60 * 1000,
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const det = detected as SkillRepairDetect;
      const primary = det.skillTargetDirs[0] ?? DEFAULT_PROJECT_SKILLS_DIR;
      const fileTree = det.__fileTree ?? '';
      return det.failingSkills.map((f) => ({
        agentId: f.skillId.slice(0, 120),
        agentTitle: f.skillId,
        prompt: buildSkillRepairPrompt({
          skillId: f.skillId,
          issues: f.issues,
          skillMdExcerpt: f.skillMdExcerpt,
          framework: det.framework,
          language: det.language,
          kbFiles: det.kbFiles,
          fileTree,
          scopeExclude: det.__scopeExclude ?? [],
          skillsDir: primary,
        }),
      }));
    },
  },

  async apply(ctx, args): Promise<SkillRepairApply> {
    const detected = args.detected as SkillRepairDetect;
    const targetDirs =
      detected.skillTargetDirs && detected.skillTargetDirs.length > 0
        ? detected.skillTargetDirs
        : [DEFAULT_PROJECT_SKILLS_DIR];
    const results = args.agentMiningResults ?? [];

    const repaired: string[] = [];
    const stillFailing: string[] = [];

    for (const failing of detected.failingSkills) {
      const res = results.find((r) => r.agentId === failing.skillId.slice(0, 120));
      const entries =
        res && res.status === 'done' ? parseSkillEntries(res.output ?? res.rawOutput) : [];
      // Prefer the entry whose id matches; fall back to the single returned skill.
      const match =
        entries.find((e) => sanitizeSkillId(e.id) === failing.skillId) ?? entries[0] ?? null;
      // No valid, sub-skill-bearing repair → leave the broken skill in place for 09_6.
      if (!match || !hasSubSkills(match)) {
        stillFailing.push(failing.skillId);
        continue;
      }
      // Force the id to the on-disk dir name so a stray agent rename can't misplace the write.
      const entry: SkillEntry = { ...match, id: failing.skillId };
      const skillMd = skillToMarkdown(entry);
      const subs = sanitizeSubSkills(entry);

      for (const dir of targetDirs) {
        const parts = dir.split('/').filter((p) => p.length > 0);
        const skillDir = path.join(ctx.repoPath, ...parts, failing.skillId);
        // Clear the dir before rewriting so stale/broken leaf files from the truncated
        // generation don't survive and re-fail verification.
        await rm(skillDir, { recursive: true, force: true });
        await mkdir(skillDir, { recursive: true });
        await writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
        if (subs.length > 0) {
          const subDir = path.join(skillDir, 'sub-skills');
          await mkdir(subDir, { recursive: true });
          for (const sub of subs) {
            await writeFile(
              path.join(subDir, `${sub.slug}.md`),
              subSkillToMarkdown(entry.id, sub),
              'utf8',
            );
          }
        }
      }
      repaired.push(failing.skillId);
    }

    // Rebuild the README index from the current on-disk set so descriptions stay in sync.
    if (repaired.length > 0) {
      for (const dir of targetDirs) {
        const summaries = await readDiskSkillSummaries(ctx.repoPath, dir);
        if (summaries.length === 0) continue;
        const parts = dir.split('/').filter((p) => p.length > 0);
        const readmePath = path.join(ctx.repoPath, ...parts, 'README.md');
        await mkdir(path.dirname(readmePath), { recursive: true });
        await writeFile(readmePath, skillsReadmeMarkdown(summaries, dir), 'utf8');
      }
    }

    ctx.logger.info(
      {
        attempted: detected.failingSkills.length,
        repaired: repaired.length,
        stillFailing: stillFailing.length,
      },
      'skill repair apply complete',
    );
    return { repaired, stillFailing, attempted: detected.failingSkills.length };
  },
};
