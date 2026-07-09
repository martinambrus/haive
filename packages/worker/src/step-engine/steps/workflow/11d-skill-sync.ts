import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DetectResult, SkillEntry } from '@haive/shared';
import { mapWithConcurrency } from '@haive/shared';
import type { AgentMiningDispatch, StepContext, StepDefinition } from '../../step-definition.js';
import { resolveParallelCap } from '../../_parallel-cap.js';
import { resolveUserGitEnv } from '../../../secrets/user-git-identity.js';
import type { KbFileSummary } from '../onboarding/09-qa.js';
import {
  loadPreviousStepOutput,
  pathExists,
  resolveSkillTargetDirs,
} from '../onboarding/_helpers.js';
import { buildSkillContractBlocks } from '../onboarding/_skill-prompt.js';
import {
  loadMiningScopeExcludeGlobs,
  noSubagentInstructionLines,
  scopeInstructionLines,
} from '../onboarding/_scope.js';
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
} from '../onboarding/09_5-skill-generation.js';
import { listSkillDirs, loadBundleSkillIds } from '../onboarding/09_6-skill-verification.js';
import { readDiskSkillSummaries } from '../onboarding/09_5b-skill-repair.js';
import type { SkillSyncOp } from './11-phase-8-learning.js';
import { requireUsableGit } from '../../../repo/git-workspace.js';

const execFileP = promisify(execFile);
const DEFAULT_PROJECT_SKILLS_DIR = '.claude/skills';
const STEP_ID = '11d-skill-sync';
// One skill's JSON is one bounded generation-worth of output (fits the model ceiling),
// so no shrink is needed — mirrors 09_5b's repair mandate.
const SYNC_MAX_SUB = 8;
const SYNC_BODY_LEN = '100-250';
const DEFAULT_SKILL_SYNC_COMMIT_MESSAGE = 'docs: sync skills from workflow task';
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

/** A new/update skill the sync will generate. `kind` is resolved in detect: a
 *  new_feature whose capability collides with an existing skill id becomes an update. */
interface SkillSyncTarget {
  kind: 'new' | 'update';
  /** Final on-disk skill id (sanitized capability for new; the pinned id for update). */
  skillId: string;
  /** new_feature capability name (drives the generation prompt); '' for an update. */
  capability: string;
  rationale: string;
  /** First ~2000 chars of the current SKILL.md for an update; null for a new skill. */
  skillMdExcerpt: string | null;
}

interface SkillSyncDetect {
  /** new/update skills to generate (one agent dispatch each). */
  targets: SkillSyncTarget[];
  /** Skill ids to delete from disk (approved removals). */
  removals: string[];
  /** Every enabled provider's skills dir; each change is mirrored into all of them. */
  skillTargetDirs: string[];
  /** The feature-branch worktree the pipeline operates in (from 01-worktree-setup). */
  worktreePath: string;
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  /** Transient file tree for agent orientation; mirrors 09_5b's __fileTree. */
  __fileTree?: string;
  /** Transient per-task mining deny list; drives the hard-scope prompt section. */
  __scopeExclude?: string[];
}

interface SkillSyncApply {
  /** Skill ids written (new or updated). */
  generated: string[];
  /** Skill ids removed from disk. */
  removed: string[];
  /** Skill ids whose agent returned nothing usable — left untouched (an update keeps
   *  the prior skill; a new one is simply not created). */
  skipped: string[];
  committed: boolean;
  commitSha: string | null;
}

/** The learning step's persisted skill-sync decisions (11-phase-8-learning output). */
interface LearningSkillSyncOutput {
  skillSync?: { newUpdate?: SkillSyncOp[]; remove?: SkillSyncOp[] } | null;
}

async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const opts = env ? { cwd, env: { ...process.env, ...env } } : { cwd };
    const { stdout, stderr } = await execFileP('git', args, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** Resolve the worktree the learning phase wrote into (mirrors 11-phase-8-learning /
 *  11b-kb-commit): the 01-worktree-setup path, falling back to the repo workspace. */
async function resolveWorktree(ctx: StepContext): Promise<string> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const out = prev?.output as { worktreePath?: string } | null;
  return out?.worktreePath ?? ctx.workspacePath;
}

async function loadLearningSkillSync(
  ctx: StepContext,
): Promise<{ newUpdate: SkillSyncOp[]; remove: SkillSyncOp[] }> {
  const learning = await loadPreviousStepOutput(ctx.db, ctx.taskId, '11-phase-8-learning');
  const ss = (learning?.output as LearningSkillSyncOutput | null)?.skillSync;
  return {
    newUpdate: Array.isArray(ss?.newUpdate) ? ss!.newUpdate! : [],
    remove: Array.isArray(ss?.remove) ? ss!.remove! : [],
  };
}

/** Build one skill's generation prompt. Reuses the shared JSON contract blocks so the
 *  emitted shape is identical to onboarding generation; the framing differs by kind —
 *  an update corrects a named existing skill (id pinned, current SKILL.md shown), a new
 *  one is created for a capability the task added. Grep-first, in-scope only. */
function buildSkillSyncPrompt(opts: {
  target: SkillSyncTarget;
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  fileTree: string;
  scopeExclude: string[];
  skillsDir: string;
}): string {
  const { target } = opts;
  const kbList =
    opts.kbFiles.length > 0
      ? opts.kbFiles
          .map(
            (f) =>
              `- ${f.relPath} — ${f.title}` +
              (f.sectionHeadings.length > 0
                ? `\n    sections: ${f.sectionHeadings.slice(0, 8).join('; ')}`
                : ''),
          )
          .join('\n')
      : '(no knowledge base files yet)';

  const framing =
    target.kind === 'update'
      ? [
          `## Skill to update: \`${target.skillId}\``,
          '',
          `Keep this id EXACTLY — it is the on-disk directory name under \`${opts.skillsDir}/\`. Do NOT rename it`,
          'and do NOT produce a skill for any other capability.',
          '',
          'This task CHANGED the capability this skill documents. What changed:',
          `  ${target.rationale || '(the reviewer gave no detail — infer from the code)'}`,
          '',
          'Keep the parts that are still correct, correct every now-stale statement so nothing contradicts the',
          'current code, and regenerate the sub-skills so the required structure below is fully satisfied.',
          '',
          target.skillMdExcerpt
            ? [
                '## Current SKILL.md (on disk now)',
                '',
                '```markdown',
                target.skillMdExcerpt,
                '```',
                '',
              ].join('\n')
            : '',
        ]
      : [
          `## Skill to create: \`${target.skillId}\``,
          '',
          `Use this id EXACTLY as the on-disk directory name under \`${opts.skillsDir}/\`.`,
          '',
          `This task ADDED a new capability: "${target.capability}". What it does:`,
          `  ${target.rationale || '(the reviewer gave no detail — infer from the code)'}`,
          '',
          'Create a COMPLETE skill grounded in the code that implements this capability.',
          '',
        ];

  return [
    "You are a senior software engineer keeping this project's Claude Code SKILLS in sync with a",
    'change a workflow task just made. Produce ONE skill as JSON.',
    '',
    ...framing,
    '## Project context',
    '',
    `Framework: ${opts.framework ?? 'unknown'}`,
    `Language: ${opts.language ?? 'unknown'}`,
    '',
    '## Existing knowledge base (consult these for domain understanding)',
    '',
    kbList,
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
    'You are producing ONE skill for ONE capability, so you need only the NARROW SLICE of code that',
    'implements it — not a survey of the project. Work in a targeted way:',
    '',
    '1. Use the knowledge base above and the change description to fix the exact terminology and the',
    '   module / service / class / route / hook / field names this capability uses.',
    opts.scopeExclude.length > 0
      ? '2. GREP the in-scope directories for those terms (never the out-of-scope dirs listed under "Mining scope") to LOCATE the few files that implement this capability. Lead with Grep/Glob — do NOT read files one by one just to discover what is where.'
      : '2. GREP the repository for those terms to LOCATE the few files that implement this capability. Lead with Grep/Glob — do NOT read files one by one just to discover what is where.',
    '3. Read ONLY the located files and their DIRECT dependencies. Stop as soon as you understand THIS capability — do not open unrelated files or walk the whole tree.',
    '4. Emit the corrected/created skill as JSON (a `skills` array of length 1). Do NOT return an empty array — the skill is required.',
    '',
    ...buildSkillContractBlocks(SYNC_MAX_SUB, SYNC_BODY_LEN),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Write one skill (SKILL.md + sub-skills) into every mirror dir, clearing the dir first
 *  so stale leaf files never survive. Mirrors the 09_5 / 09_5b write loop. */
async function writeSkillTree(
  worktree: string,
  targetDirs: string[],
  entry: SkillEntry,
): Promise<void> {
  const skillMd = skillToMarkdown(entry);
  const subs = sanitizeSubSkills(entry);
  for (const dir of targetDirs) {
    const parts = dir.split('/').filter((p) => p.length > 0);
    const skillDir = path.join(worktree, ...parts, entry.id);
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
}

export const skillSyncStep: StepDefinition<SkillSyncDetect, SkillSyncApply> = {
  metadata: {
    id: STEP_ID,
    workflowType: 'workflow',
    index: 11.4,
    title: 'Skill sync',
    description:
      'Regenerates or updates the project skills the learning phase decided this task built or changed, and deletes skills for removed capabilities the reviewer approved. Reuses the onboarding skill generator; runs unattended (the review already happened in the learning form).',
    requiresCli: true,
    providerSensitive: true,
    // Same corruption risk as 09_5: a weak local model can produce a malformed skill.
    unsafeForLocalModels: true,
    allowSkip: true,
  },

  // Run only when the learning phase persisted approved skill-sync ops.
  async shouldRun(ctx: StepContext): Promise<boolean> {
    const { newUpdate, remove } = await loadLearningSkillSync(ctx);
    return newUpdate.length > 0 || remove.length > 0;
  },

  async detect(ctx: StepContext): Promise<SkillSyncDetect> {
    const { newUpdate, remove } = await loadLearningSkillSync(ctx);
    const worktreePath = await resolveWorktree(ctx);
    const skillTargetDirs = await resolveSkillTargetDirs(ctx.db, ctx.userId, [
      DEFAULT_PROJECT_SKILLS_DIR,
    ]);
    const bundleSkillIds = await loadBundleSkillIds(ctx);
    const cap = await resolveParallelCap();

    // Existing skill ids across every mirror (ground truth) — for new/update collision
    // resolution and to drop an op that names a skill no longer on disk.
    const idsByDir = await mapWithConcurrency(skillTargetDirs, cap, (dir) =>
      listSkillDirs(worktreePath, dir),
    );
    const existingIds = new Set(idsByDir.flat());

    const readExcerpt = async (skillId: string): Promise<string | null> => {
      for (const dir of skillTargetDirs) {
        const parts = dir.split('/').filter((p) => p.length > 0);
        const skillMd = path.join(worktreePath, ...parts, skillId, 'SKILL.md');
        if (await pathExists(skillMd)) {
          try {
            const text = await readFile(skillMd, 'utf8');
            return text.length > 2000 ? text.slice(0, 2000) : text;
          } catch {
            return null;
          }
        }
      }
      return null;
    };

    const targets: SkillSyncTarget[] = [];
    const seen = new Set<string>();
    for (const op of newUpdate) {
      let skillId: string;
      let kind: 'new' | 'update';
      let capability = '';
      if (op.op === 'feature_update') {
        skillId = (op.skillId ?? '').trim();
        if (!skillId || !existingIds.has(skillId)) continue; // guard: must exist
        kind = 'update';
      } else {
        // new_feature: id from the capability. A collision with an existing skill is an update.
        capability = (op.capability ?? '').trim();
        skillId = sanitizeSkillId(capability) ?? '';
        if (!skillId) continue;
        kind = existingIds.has(skillId) ? 'update' : 'new';
      }
      // Never auto-touch a user-supplied bundle skill, and de-dup ops targeting the same id.
      if (bundleSkillIds.has(skillId) || seen.has(skillId)) continue;
      seen.add(skillId);
      targets.push({
        kind,
        skillId,
        capability,
        rationale: op.rationale ?? '',
        skillMdExcerpt: kind === 'update' ? await readExcerpt(skillId) : null,
      });
    }

    const removals: string[] = [];
    for (const op of remove) {
      const skillId = (op.skillId ?? '').trim();
      if (!skillId || !existingIds.has(skillId) || bundleSkillIds.has(skillId)) continue;
      if (!removals.includes(skillId) && !seen.has(skillId)) removals.push(skillId);
    }

    // Generation grounding context (same sources as 09_5b.detect).
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;
    const kbFiles = await listKbFiles(worktreePath);
    const scopeExclude = await loadMiningScopeExcludeGlobs(ctx.db, ctx.taskId);
    const fileTree =
      targets.length > 0 ? await collectShortFileTree(worktreePath, scopeExclude) : '';

    ctx.logger.info(
      { targets: targets.length, removals: removals.length, targetDirs: skillTargetDirs },
      'skill sync detect complete',
    );
    return {
      targets,
      removals,
      skillTargetDirs,
      worktreePath,
      framework,
      language,
      kbFiles,
      __fileTree: fileTree,
      __scopeExclude: scopeExclude,
    };
  },

  // One generation agent per new/update target (parallel, capped by the runner). agentId
  // = skillId so apply maps each result back to its skill. Empty under test bypass or a
  // removals-only run → no dispatch, apply still handles removals + the commit.
  agentMining: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 60 * 60 * 1000,
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const det = detected as SkillSyncDetect;
      const primary = det.skillTargetDirs[0] ?? DEFAULT_PROJECT_SKILLS_DIR;
      const fileTree = det.__fileTree ?? '';
      return det.targets.map((target) => ({
        agentId: target.skillId.slice(0, 120),
        agentTitle: target.skillId,
        prompt: buildSkillSyncPrompt({
          target,
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

  async apply(ctx, args): Promise<SkillSyncApply> {
    const detected = args.detected as SkillSyncDetect;
    const worktree = detected.worktreePath;
    const targetDirs =
      detected.skillTargetDirs.length > 0 ? detected.skillTargetDirs : [DEFAULT_PROJECT_SKILLS_DIR];
    const results = args.agentMiningResults ?? [];

    const generated: string[] = [];
    const skipped: string[] = [];

    for (const target of detected.targets) {
      const res = results.find((r) => r.agentId === target.skillId.slice(0, 120));
      const entries =
        res && res.status === 'done' ? parseSkillEntries(res.output ?? res.rawOutput) : [];
      const match =
        entries.find((e) => sanitizeSkillId(e.id) === target.skillId) ?? entries[0] ?? null;
      // No valid, sub-skill-bearing result → skip (an update keeps the prior skill on disk;
      // a new one is simply not created). We only touch disk once we have a good skill.
      if (!match || !hasSubSkills(match)) {
        skipped.push(target.skillId);
        continue;
      }
      const entry: SkillEntry = { ...match, id: target.skillId };
      await writeSkillTree(worktree, targetDirs, entry);
      generated.push(target.skillId);
    }

    const removed: string[] = [];
    for (const skillId of detected.removals) {
      for (const dir of targetDirs) {
        const parts = dir.split('/').filter((p) => p.length > 0);
        await rm(path.join(worktree, ...parts, skillId), { recursive: true, force: true });
      }
      removed.push(skillId);
    }

    // Rebuild the README index from the current on-disk set so it reflects adds/removes.
    if (generated.length > 0 || removed.length > 0) {
      for (const dir of targetDirs) {
        const summaries = await readDiskSkillSummaries(worktree, dir);
        const parts = dir.split('/').filter((p) => p.length > 0);
        const readmePath = path.join(worktree, ...parts, 'README.md');
        if (summaries.length === 0) {
          await rm(readmePath, { force: true });
          continue;
        }
        await mkdir(path.dirname(readmePath), { recursive: true });
        await writeFile(readmePath, skillsReadmeMarkdown(summaries, dir), 'utf8');
      }
    }

    // Self-commit the skill dirs onto the feature branch (the learning form already gated
    // this, so no separate confirmation). Mirrors 11b-kb-commit; a separate commit from the
    // KB one keeps 11b's KB-scoped gating untouched.
    let committed = false;
    let commitSha: string | null = null;
    const changed = generated.length > 0 || removed.length > 0;
    // Only probed when there is something to commit; throws on a corrupt repo so the
    // generated skills are not silently left uncommitted.
    const hasGit = changed && (await requireUsableGit(worktree));
    if (hasGit) {
      const present: string[] = [];
      for (const dir of targetDirs) {
        if (await pathExists(path.join(worktree, dir))) present.push(dir);
      }
      if (present.length > 0) {
        const add = await gitRun(worktree, ['add', '--', ...present]);
        if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
        const userEnv = await resolveUserGitEnv(ctx.db, ctx.userId);
        const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
        const commit = await gitRun(
          worktree,
          ['commit', '-m', DEFAULT_SKILL_SYNC_COMMIT_MESSAGE],
          commitEnv,
        );
        if (commit.code === 0) {
          const sha = await gitRun(worktree, ['rev-parse', 'HEAD']);
          commitSha = sha.code === 0 ? sha.stdout.trim() : null;
          committed = true;
        } else if (!/nothing to commit/i.test(commit.stderr || commit.stdout)) {
          throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
        }
      }
    }

    ctx.logger.info(
      { generated: generated.length, removed: removed.length, skipped: skipped.length, committed },
      'skill sync apply complete',
    );
    return { generated, removed, skipped, committed, commitSha };
  },
};
