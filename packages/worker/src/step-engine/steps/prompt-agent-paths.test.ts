import { describe, expect, it } from 'vitest';
import { promptNamesAgentPath } from '@haive/shared';
import { StepRegistry } from '../registry.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { stripAgentGuidanceBlocks } from './_retrieval-guidance.js';
import { registerAllSteps } from './index.js';
import { buildRefutePrompt } from './workflow/08c-code-review.js';
import { buildExpandPrompt } from './plan/01-plan-build.js';
import { buildAgentSelectorPrompt } from './workflow/_agent-selector.js';
import { buildEnrichPrompt } from './kb-author/01-enrich.js';
import { advisorPrompt, fixCoderPrompt, replannerPrompt, reviewerPrompt } from '../dag-executor.js';
import { buildMergeFixPrompt } from '../git-merge.js';
import { globalKbDigestPrompt } from './_global-kb-digest.js';
import { mcpSurfacePrompt } from '../../sandbox/mcp-surface.js';
import { appReachPrompt } from '../../queues/cli-exec/app-reach.js';
import { buildAgentMiningSummaryPrompt, buildStepSummaryPrompt } from '../step-runner.js';
import { WORKTREE_GIT_BOUNDARY_PROMPT } from '../../repo/worktree-git-boundary.js';
import { DDEV_GENERATED_BOUNDARY_PROMPT } from '../../repo/ddev-generated-boundary.js';
import { PROMPT_DEFECT_INSTRUCTION } from './workflow/_prompt-defect.js';

/**
 * Verification item 2's tripwire: which BUILT-IN prompts name an agent directory once Haive's own
 * marker blocks are stripped — i.e. which ones `agentIsolationApplies` refuses to isolate.
 *
 * It has to be the BUILT prompt, not the source file. A grep over `steps/**` matches 23 files,
 * because the source also carries prose in comments, `agentDefinitionGuidance(...)` calls whose
 * rendered block is stripped before the scan, and code that WRITES those files
 * (`_agent-templates.ts`, `_scope.ts`). None of those end isolation; a bare path in prompt text does.
 *
 * FOUR dispatch paths reach the isolation rule, and an earlier version of this file scanned only the
 * first (the fourth is documented at NAMED_PROMPT_BUILDERS below, with the part of it that stays out
 * of reach):
 *
 *   1. `llm.buildPrompt(args)`
 *   2. `loop.buildIterationPrompt(args)` — `step-runner.ts:707` routes to it whenever
 *      `upcomingIteration > 0 || truncationRetries > 0`, so it is the prompt for every pass past the
 *      first (05, 07a, 07b, 08a, 09_5 define one).
 *   3. `agentMining.selectAgents(args)` — each returned `AgentMiningDispatch.prompt` is dispatched
 *      with `kind: 'prompt'`, so a fan-out's prompts are scanned exactly like a single one. Ten
 *      built-in steps declare mining.
 *
 * The registry is booted through `registerAllSteps`, the production entry point, so a step added to
 * any workflow index is covered without touching this file.
 *
 * A FIFTH source is not a registry path at all: prompts dispatched DIRECTLY through
 * `resolveTaskDispatch` by `dag-executor` (reviewer, advisor, replanner, fix-coder), the
 * merge-resolver's fix prompt, and the blocks spliced into other prompts (`mcpSurfacePrompt`,
 * `globalKbDigestPrompt`, `appReachPrompt`). Those are listed by name in NAMED_PROMPT_BUILDERS, and
 * the last case in this file FAILS if a newly exported `*Prompt` symbol is neither scanned nor
 * excluded with a reason — which is what ends the review-by-review discovery that built this list.
 *
 * With every source above and permissive inputs, 40+ prompts are actually built and scanned (the
 * floor this file asserts, so a drop is visible), and the
 * measured positives are exactly the two the plan predicted — `06_5-agent-discovery` and
 * `09_5-skill-generation`. An earlier version of this file reached only 14 prompts on one path and
 * reported NONE, which read as "no built-in prompt names an agent path" and was false.
 */
function bootRegistry(): StepRegistry {
  const registry = new StepRegistry();
  // The PRODUCTION registration, never a hand-kept list of workflow types. This file first rolled its
  // own and omitted `registerEnvReplicateSteps` while claiming to cover every type. `registerAllSteps`
  // also runs the four boot sanity checks, so their drift surfaces here too.
  registerAllSteps(registry);
  return registry;
}

/**
 * A stand-in for every input a prompt builder reads: `detected`, `formValues`, `llmOutput` and the
 * mining `ctx`.
 *
 * Bespoke fixtures per builder were the obvious alternative and are worse: 26 of them, each shaped
 * to one step's detect payload, drifting whenever that payload changes and failing for reasons
 * unrelated to agent paths. What this test asks is whether a builder's own TEMPLATE TEXT carries a
 * bare agent path, and that text comes from the module, never from the data — so exercising the
 * template with benign empties is the sound way to reach it.
 *
 * Every access answers, so a builder that dereferences deeply still runs: unknown properties give
 * another permissive value, `map`/`filter`/`slice` give `[]`, `join`/`trim`/`replace` give `''`,
 * iteration is empty, and string interpolation yields `''`. `then` is undefined so `await` resolves
 * rather than hanging on a thenable, and `toJSON` answers a plain `{}` — see the note at that line
 * for the two opposite failures that shape it.
 */
function permissive(): never {
  const target = function noop(): void {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      // A PLAIN empty object, not another proxy: several builders do
      // `JSON.stringify(x).slice(0, N)`, and stringify of a function target answers `undefined`,
      // so `.slice` would throw — while a proxy-returning toJSON would send stringify into
      // recursion. Both failure modes were observed here.
      if (prop === 'toJSON') return () => ({});
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) {
        return () => '';
      }
      if (prop === Symbol.iterator) return function* empty() {};
      if (prop === 'length' || prop === 'size') return 0;
      if (prop === 'map' || prop === 'filter' || prop === 'flatMap') return () => [];
      if (prop === 'slice' || prop === 'concat' || prop === 'split' || prop === 'sort')
        return () => [];
      if (prop === 'join' || prop === 'trim' || prop === 'replace' || prop === 'replaceAll') {
        return () => '';
      }
      if (prop === 'toLowerCase' || prop === 'toUpperCase') return () => '';
      if (prop === 'forEach') return () => undefined;
      if (prop === 'find' || prop === 'at' || prop === 'get') return () => undefined;
      if (prop === 'some' || prop === 'every' || prop === 'includes' || prop === 'has') {
        return () => false;
      }
      return permissive();
    },
    apply() {
      return permissive();
    },
  }) as never;
}

interface Scanned {
  named: string[];
  clean: string[];
  unbuildable: string[];
}

interface PromptSource {
  label: string;
  build: () => string | Promise<string[]>;
}

/**
 * A FOURTH path: prompts thrown as a later mining wave (`MiningWaveError.dispatches`), which
 * `step-runner` re-dispatches through `resolveTaskDispatch` exactly like a first wave.
 *
 * Eight wave sites exist across five steps (08c, 08d, 01-plan-build, 02-plan-coverage,
 * 03-plan-sequence). Only the ones with a NAMED builder are reachable from a unit test: the other six
 * assemble their dispatch arrays inline inside `apply()`, so covering them would mean either
 * extracting that logic in five production modules or executing `apply()` bodies in CI — which for
 * steps that write files is a side effect a test should not have. That gap is stated in the coverage
 * case below rather than papered over.
 *
 * 08c's refuter is the one Codex named: read-only (`requiredCapabilities: ['tool_use']`), so the path
 * scan decides its isolation, and it was previously invisible here.
 */
const NAMED_PROMPT_BUILDERS: PromptSource[] = [
  {
    label: '08c-code-review buildRefutePrompt (wave 2)',
    build: () => buildRefutePrompt(permissive(), permissive(), permissive()),
  },
  {
    label: '01-plan-build buildExpandPrompt (wave N)',
    build: () => buildExpandPrompt(permissive(), permissive(), permissive(), permissive()),
  },
  {
    label: '_agent-selector buildAgentSelectorPrompt',
    build: () => buildAgentSelectorPrompt(permissive()),
  },
  { label: '01-enrich buildEnrichPrompt', build: () => buildEnrichPrompt(permissive()) },
  // dag-executor dispatches these DIRECTLY through `resolveTaskDispatch` with `kind: 'prompt'` and
  // `tool_use` only — no registry step owns them, so nothing above would ever reach them.
  { label: 'dag reviewerPrompt', build: () => reviewerPrompt(permissive(), permissive()) },
  { label: 'dag advisorPrompt', build: () => advisorPrompt(permissive(), permissive()) },
  {
    label: 'dag replannerPrompt',
    build: () => replannerPrompt(permissive(), permissive(), permissive()),
  },
  {
    label: 'dag fixCoderPrompt',
    build: () => fixCoderPrompt(permissive(), permissive(), permissive()),
  },
  // merge-resolver's conflict-resolution prompt.
  {
    label: 'git-merge buildMergeFixPrompt',
    build: () => buildMergeFixPrompt(permissive(), permissive(), permissive()),
  },
  // Blocks SPLICED INTO other prompts. A bare agent path in one of these would end isolation for
  // every dispatch that carries it, which is broader than any single step.
  { label: 'globalKbDigestPrompt (block)', build: () => globalKbDigestPrompt(permissive()) },
  { label: 'mcpSurfacePrompt (block)', build: () => mcpSurfacePrompt(permissive(), permissive()) },
  { label: 'appReachPrompt (block)', build: () => appReachPrompt(permissive()) },
  // The step-summary pass. `maybeEnqueueStepSummary` dispatches BOTH of these through
  // `resolveTaskDispatch` with `kind: 'prompt'` and no capabilities, so isolation applies to them like
  // anything else — the invocation being unlinked (`task_step_id` NULL) is an attribution fact and
  // exempts it from nothing. Excluding the exported one on that reasoning was simply wrong.
  {
    label: 'buildStepSummaryPrompt',
    build: () => buildStepSummaryPrompt(permissive(), permissive(), permissive()),
  },
  {
    label: 'buildAgentMiningSummaryPrompt',
    build: () => buildAgentMiningSummaryPrompt(permissive(), permissive(), permissive()),
  },
  // Constant blocks the DISPATCHER injects, named by the repository's `*_PROMPT` convention rather
  // than a `build*` function. A bare agent path in one of these would reach every prompt that carries
  // it, after the isolation decision was already taken.
  {
    label: 'WORKTREE_GIT_BOUNDARY_PROMPT (const block)',
    build: () => WORKTREE_GIT_BOUNDARY_PROMPT,
  },
  {
    label: 'DDEV_GENERATED_BOUNDARY_PROMPT (const block)',
    build: () => DDEV_GENERATED_BOUNDARY_PROMPT,
  },
  { label: 'PROMPT_DEFECT_INSTRUCTION (const block)', build: () => PROMPT_DEFECT_INSTRUCTION },
];

/**
 * Exported `*Prompt` symbols that are deliberately NOT scanned, each with the reason. The
 * completeness case below fails if a new one appears in neither list — which is what ends the
 * round-by-round discovery that produced this file: llm, then loop, then mining, then waves, then
 * dag-executor's direct dispatches were each found one review at a time.
 */
const SCANNED_PROMPT_EXPORTS = [
  'buildRefutePrompt',
  'buildExpandPrompt',
  'buildAgentSelectorPrompt',
  'buildEnrichPrompt',
  'reviewerPrompt',
  'advisorPrompt',
  'replannerPrompt',
  'fixCoderPrompt',
  'buildMergeFixPrompt',
  'globalKbDigestPrompt',
  'mcpSurfacePrompt',
  'appReachPrompt',
  'buildStepSummaryPrompt',
  'buildAgentMiningSummaryPrompt',
  'WORKTREE_GIT_BOUNDARY_PROMPT',
  'DDEV_GENERATED_BOUNDARY_PROMPT',
  'PROMPT_DEFECT_INSTRUCTION',
];

const NOT_A_DISPATCHED_PROMPT: Record<string, string> = {
  antigravityStdinPrompt: 'wraps an already-built prompt for stdin; adds no text of its own',
  deliverPrompt: 'delivery mechanism (argv vs stdin), not a builder',
  expiredPromptFilter: 'a SQL predicate for stream-log retention',
  adaptPromptForCliCapabilities: 'the rewriter the scan itself runs, not a source of text',
  appAuthPromptLines: 'lines appended to a browser-verify prompt; covered via 08a above',
  parsePromptDefects: 'a parser of agent OUTPUT',
  assembleNativePrompt:
    'sub-agent assembly — `input.kind` is not `prompt` there, so agentIsolationApplies excludes it',
  buildAgentDiscoveryPrompt: "06_5's llm builder, already scanned through the registry",
  PROMPT_ARGV_LIMIT_BYTES: 'a byte limit for argv delivery, not text',
  PROMPT_FILE_PATH: 'the in-container path a long prompt is written to, not text',
  promptCarriesPastedPersona: 'a predicate ABOUT a prompt; contributes no text',
  promptDefectFingerprint: 'a fingerprint over a defect, not prompt text',
  promptGuidanceStep:
    '11e-prompt-guidance StepDefinition — already scanned through the registry; it matches only ' +
    'because the step is NAMED for prompts',
  // The four augmenters take a `db` and RETURN THE PROMPT UNCHANGED when there is no data — no
  // ledger entries, no attachments, no learned guidance, no stored terseness level. Scanning them
  // with permissive inputs would therefore exercise none of their own text and report a vacuous
  // clean, which is the failure mode this file has already been corrected for twice. Their added
  // text is data-derived (filenames, stored guidance) rather than a static template, so a fixed bare
  // agent path cannot live in the part that varies; a path in their unconditional wrapper text is a
  // real residual gap and is recorded as one here.
  augmentPromptWithLedger: 'data-derived; returns the prompt unchanged with no ledger entries',
  augmentPromptWithAttachments: 'data-derived; returns the prompt unchanged with no attachments',
  augmentPromptWithLearnedGuidance: 'data-derived; returns the prompt unchanged with no guidance',
  augmentPromptWithTerseness: 'reads a config value; returns the prompt unchanged when unset',
};

/** Every prompt production can dispatch, across all three registry paths plus the named builders. */
function promptSources(): PromptSource[] {
  const out: PromptSource[] = [...NAMED_PROMPT_BUILDERS];
  for (const def of bootRegistry().all()) {
    const id = def.metadata.id;
    const llm = def.llm;
    if (llm) {
      out.push({
        label: id,
        build: () => llm.buildPrompt({ detected: permissive(), formValues: permissive() }),
      });
    }
    const iteration = def.loop?.buildIterationPrompt;
    if (iteration) {
      out.push({
        label: `${id} (loop iteration)`,
        build: () =>
          iteration({
            detected: permissive(),
            formValues: permissive(),
            iteration: 1,
            previousIterations: [],
          }),
      });
    }
    const mining = def.agentMining;
    if (mining) {
      out.push({
        label: `${id} (mining)`,
        build: async () => {
          const dispatches = await mining.selectAgents({
            ctx: permissive(),
            detected: permissive(),
            formValues: permissive(),
            llmOutput: permissive(),
          });
          return dispatches.map((d) => d.prompt);
        },
      });
    }
  }
  return out;
}

async function scanBuiltPrompts(): Promise<Scanned> {
  const out: Scanned = { named: [], clean: [], unbuildable: [] };
  for (const source of promptSources()) {
    let prompts: string[];
    try {
      const built = await source.build();
      prompts = typeof built === 'string' ? [built] : built;
    } catch {
      out.unbuildable.push(source.label);
      continue;
    }
    // A mining step that selects no agent under empty inputs produced no prompt to scan — not the
    // same thing as a clean one, so it is reported rather than counted as covered.
    if (prompts.length === 0) {
      out.unbuildable.push(source.label);
      continue;
    }
    // Exactly what the dispatch rule does: strip Haive's own marker blocks, then scan what is left.
    const names = prompts.some((p) =>
      promptNamesAgentPath(stripAgentGuidanceBlocks(p), SANDBOX_WORKDIR),
    );
    if (names) out.named.push(source.label);
    else out.clean.push(source.label);
  }
  out.named.sort();
  out.clean.sort();
  out.unbuildable.sort();
  return out;
}

describe('built-in prompt builders vs agentIsolationApplies', () => {
  it('boots every workflow type, so no registered step escapes the scan', () => {
    const ids = bootRegistry()
      .all()
      .map((d) => d.metadata.id);
    expect(ids.length).toBeGreaterThan(40);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('07-generate-files');
    expect(ids).toContain('08c-code-review');
  });

  it('covers all three dispatch paths', () => {
    const labels = promptSources().map((s) => s.label);
    // Each path is asserted present, because each was missing at some point in this file's history:
    // mining and loop-iteration prompts were both invisible while every count still looked plausible.
    expect(labels.some((l) => l.endsWith('(loop iteration)'))).toBe(true);
    expect(labels.some((l) => l.endsWith('(mining)'))).toBe(true);
    expect(labels.some((l) => !l.endsWith(')'))).toBe(true);
  });

  it('names exactly the prompts that would NOT be isolated', async () => {
    const { named } = await scanBuiltPrompts();
    // MEASURED 2026-09-22 across all three dispatch paths — and it is exactly what the plan
    // predicted: 06_5 and 09_5, nobody else. An entry here is a step whose own prompt disables its
    // isolation through the path scan, which has to be a decision rather than a surprise.
    //
    // Both are deliberate, for different reasons:
    //   06_5-agent-discovery declares `requiredCapabilities: []`, so this path IS what disables its
    //     isolation — and correctly: the step discovers agents and its prompt tells the model to read
    //     prior-setup definitions as evidence about the REPOSITORY. Masking that directory would hide
    //     the files it is being asked to interpret.
    //   09_5-skill-generation declares `file_write` on both its llm and mining specs, so
    //     `agentIsolationApplies` already excludes it two conditions earlier. Its paths are moot.
    //
    // An explicit list rather than a snapshot: `vitest -u` rewrites a snapshot silently.
    expect(named).toEqual([
      '06_5-agent-discovery',
      '09_5-skill-generation',
      '09_5-skill-generation (loop iteration)',
    ]);
  });

  it('is not vacuous: markers are removed and the rest of the prompt SURVIVES', async () => {
    // `named` proves nothing on its own, and there are two ways it could be wrong:
    //   1. the scan reads nothing — then no prompt would match even UNSTRIPPED;
    //   2. `stripAgentGuidanceBlocks` swallows whole prompts — then the scan reads empty strings and
    //      check 1 still passes, because it reads the unstripped text.
    const unstripped: string[] = [];
    let markerRemoved = 0;
    for (const source of promptSources()) {
      let prompts: string[];
      try {
        const built = await source.build();
        prompts = typeof built === 'string' ? [built] : built;
      } catch {
        continue;
      }
      for (const prompt of prompts) {
        if (promptNamesAgentPath(prompt, SANDBOX_WORKDIR)) unstripped.push(source.label);
        const stripped = stripAgentGuidanceBlocks(prompt);
        expect(
          stripped.trim().length,
          `${source.label}: stripping emptied the prompt`,
        ).toBeGreaterThan(0);
        if (stripped.length < prompt.length) markerRemoved += 1;
      }
    }
    expect(markerRemoved).toBeGreaterThan(0);
    expect(unstripped.length).toBeGreaterThan(0);
  });

  it('reports what it still cannot reach, and how much it covers', async () => {
    const { clean, named, unbuildable } = await scanBuiltPrompts();
    // Coverage is pinned so that WEAKENING is visible: if builders start rejecting the permissive
    // inputs, this drops and the guard shrinks without anyone noticing otherwise.
    expect(clean.length + named.length).toBeGreaterThanOrEqual(40);
    // What remains unreachable is listed rather than hidden — a mining step that selects nothing under
    // empty inputs, or a builder that rejects them outright.
    expect(unbuildable.length).toBeLessThanOrEqual(14);
    // Every NAMED builder must actually build, or the coverage claimed by listing it is fiction.
    // This is the check that would have caught a hand-added source silently landing in the
    // unreachable bucket while the counts still looked healthy.
    const namedLabels = NAMED_PROMPT_BUILDERS.map((s) => s.label);
    expect(unbuildable.filter((label) => namedLabels.includes(label))).toEqual([]);
    // KNOWN RESIDUAL GAP, stated so nobody reads this file as exhaustive: six of the eight
    // `MiningWaveError` sites (08d x2, 02-plan-coverage x3, 03-plan-sequence) assemble their dispatch
    // arrays INLINE inside `apply()`, with no named builder to call. Reaching them needs either that
    // logic extracted in five production modules, or `apply()` executed here — and several applies
    // write files, which is a side effect a unit test must not have. The two wave prompts that DO have
    // named builders (08c's refuter, plan-build's expand) are scanned above.
    expect(named).not.toContain('08c-code-review buildRefutePrompt (wave 2)');
  });

  it('classifies EVERY exported prompt symbol, so a new one cannot escape unnoticed', async () => {
    // This case exists because of how this file grew: llm, then loop iterations, then mining, then
    // mining waves, then dag-executor's direct dispatches were each found ONE REVIEW AT A TIME, and
    // every intermediate version looked complete. Enumerating the symbols ends that loop — a new
    // exported prompt builder now fails here until someone either scans it or excludes it by name.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = fileURLToPath(new URL('../../', import.meta.url));

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    const exported = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // Case-INSENSITIVE, and matched on the whole identifier rather than a `Prompt` substring
      // pattern: the repository names constant blocks in SCREAMING_CASE (`WORKTREE_GIT_BOUNDARY_PROMPT`,
      // `DDEV_GENERATED_BOUNDARY_PROMPT`), which a case-sensitive `\w*Prompt\w*` misses entirely — so
      // the first version of this "exhaustive" audit was not.
      for (const m of src.matchAll(/^export (?:async )?function (\w+)\s*\(/gm)) {
        if (/prompt/i.test(m[1]!)) exported.add(m[1]!);
      }
      for (const m of src.matchAll(/^export const (\w+)\s*[=:]/gm)) {
        if (/prompt/i.test(m[1]!)) exported.add(m[1]!);
      }
    }

    const scanned = new Set(SCANNED_PROMPT_EXPORTS);
    const unclassified = [...exported]
      .filter((name) => !scanned.has(name) && !(name in NOT_A_DISPATCHED_PROMPT))
      .sort();
    expect(unclassified).toEqual([]);

    // No stale bookkeeping either: every name claimed as scanned or excluded must still exist.
    const stale = [...scanned, ...Object.keys(NOT_A_DISPATCHED_PROMPT)]
      .filter((name) => !exported.has(name))
      .sort();
    expect(stale).toEqual([]);

    // The sweep found the tree, not an empty directory.
    expect(exported.size).toBeGreaterThan(15);
  });
});
