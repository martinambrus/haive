import { describe, expect, it } from 'vitest';
import { promptNamesAgentPath } from '@haive/shared';
import { StepRegistry } from '../registry.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import {
  adaptPromptForCliCapabilities,
  agentDefinitionGuidance,
  buildRetrievalGuidance,
  stripAgentGuidanceBlocks,
} from './_retrieval-guidance.js';
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
import { withModelCapabilityBoundary } from '../../cli-adapters/model-capabilities.js';
import {
  ADVERSARIES,
  VERIFY_LENSES,
  buildAdversaryPrompt,
  buildVerifyPrompt,
} from './workflow/08d-adversarial-qa.js';
import { buildSequencePrompt } from './plan/03-plan-sequence.js';
import { buildCoverageRepairPrompt } from './plan/02-plan-coverage.js';
import { appAuthPromptLines } from './workflow/_app-auth.js';

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
 *
 * ITS REAL LIMITATION, and it is systemic rather than a detail: a proxy fails every strict comparison
 * against a literal (`reach.mode === 'sandbox_http'`, `format === 'toml'`), so a builder driven this
 * way emits the DEFAULT branch of each conditional and no other. So "40+ prompts scanned" means 40+
 * prompts in their default variant, NOT every variant each can emit. Where a branch is known to
 * produce substantially different text, explicit fixtures are used instead of the proxy —
 * `appReachPrompt` across its three modes and TLS states, and `adaptPromptForCliCapabilities` across
 * its four (LSP, rag) cells. For the rest, an alternative branch that named an agent directory would
 * still pass this file, and that is the honest boundary of what it proves.
 */
function permissive(overrides: Record<string, unknown> = {}): never {
  const target = function noop(): void {};
  return new Proxy(target, {
    get(_t, prop) {
      // Concrete fields win. This is how a builder's non-default arms are reached without hand-building
      // a whole detect payload: name only the fields a branch turns on and let the proxy answer the
      // rest. Three consecutive review rounds found an arm the bare proxy could not render, so this is
      // the lever for that whole class rather than one more bespoke fixture.
      if (typeof prop === 'string' && Object.hasOwn(overrides, prop)) {
        return overrides[prop];
      }
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

/** A concrete McpSurface, so each branch of `mcpSurfacePrompt` is a separate scanned source. */
function mcpFixture(
  rag: boolean,
  chrome: boolean,
  ddev: boolean,
): Parameters<typeof mcpSurfacePrompt>[0] {
  return {
    ragOnly: false,
    rag: { enabled: rag, apiUrl: 'http://api:3001', token: 't' },
    chromeDevtools: { enabled: chrome, version: '1.7.0' },
    ddevControl: { enabled: ddev, apiUrl: 'http://api:3001', token: 't' },
    userServers: {},
  };
}

interface Scanned {
  named: string[];
  clean: string[];
  unbuildable: string[];
}

/**
 * One prompt a source produced, with the key that identifies it among its siblings.
 *
 * A fan-out source is N INVOCATIONS, not one: `dispatchMiningAgents` (`step-runner.ts:1477`) loops
 * `for (const dispatch of dispatches)` and hands each dispatch's own prompt to `resolveTaskDispatch`
 * separately, so isolation is decided per prompt. A source-level verdict over `.some(...)` therefore
 * cannot express the answer — once one sibling is an expected positive, a path appearing in another is
 * invisible, and a path REMOVED from one while another stays positive is invisible too.
 *
 * The key carries the index as well as the agent id: the id is what a reader needs, the index is what
 * keeps two dispatches distinct when the permissive proxy renders both ids as the same empty string.
 */
interface BuiltPrompt {
  key: string;
  prompt: string;
}

interface PromptSource {
  label: string;
  /** A bare string is ONE dispatch; an array is a fan-out, each element dispatched on its own. */
  build: () => string | Promise<BuiltPrompt[]>;
}

/** Flattens either shape into per-invocation entries, labelled the way each is dispatched. */
function builtEntries(source: PromptSource, built: string | BuiltPrompt[]): BuiltPrompt[] {
  if (typeof built === 'string') return [{ key: source.label, prompt: built }];
  return built.map((b) => ({ key: `${source.label} [${b.key}]`, prompt: b.prompt }));
}

/**
 * A FOURTH path: prompts thrown as a later mining wave (`MiningWaveError.dispatches`), which
 * `step-runner` re-dispatches through `resolveTaskDispatch` exactly like a first wave.
 *
 * Eight wave sites exist across five steps, and every one of their prompt TEMPLATES is now scanned.
 * MEASURED by reading each throw site's dispatch array: 08c:1357 `buildRefutePrompt`; 08d:1135 and
 * 08d:1244 both `buildVerifyPrompt`; 01-plan-build:849 `buildExpandPrompt`; 03-plan-sequence:883
 * `buildSequencePrompt`; 02-plan-coverage:1076 `buildCoverageRepairPrompt`; and 02-plan-coverage:995
 * and :1138 both `buildAutomaticConvergenceWave`, which wraps `buildExpandPrompt` in
 * `augmentPromptWithAttachments`.
 *
 * So what those last two leave unscanned is NOT a template but the augmenter's own contribution, which
 * is data-derived (attachment filenames) and cannot hold a fixed agent path — and MEASURED, that
 * module contains no agent-directory literal at all. Two earlier versions of this comment were wrong in
 * the same direction and are corrected rather than annotated: the first claimed six sites "assemble
 * their dispatch arrays inline" (I had read the throws, seen array construction, and not looked
 * inside), the second still said two were out of reach after one of them had been extracted.
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
  // CONCRETE fixtures, for the same reason as appReachPrompt: `mcpSurfacePrompt` branches on
  // `surface?.rag.enabled`, `chromeDevtools.enabled`, `ddevControl.enabled`, `opts.noBuiltInTools`
  // and `opts.noRepo`, and a permissive proxy is truthy for all of them — so it emitted only the
  // everything-enabled arm plus `noBuiltInTools`. The rag-disabled, noRepo, normal-tools and
  // no-browser/no-container arms are production text the dispatcher appends AFTER the isolation
  // decision, so each is exercised here.
  ...(
    [
      { label: 'full surface', surface: mcpFixture(true, true, true), opts: {} },
      { label: 'rag disabled', surface: mcpFixture(false, true, true), opts: {} },
      { label: 'no browser or container', surface: mcpFixture(true, false, false), opts: {} },
      {
        label: 'noBuiltInTools',
        surface: mcpFixture(true, true, true),
        opts: { noBuiltInTools: true },
      },
      { label: 'noRepo', surface: mcpFixture(true, true, true), opts: { noRepo: true } },
      { label: 'null surface (amp)', surface: null, opts: {} },
      { label: 'worktree', surface: mcpFixture(true, true, true), opts: { hasWorktree: true } },
    ] as const
  ).map((cell) => ({
    label: `mcpSurfacePrompt (${cell.label})`,
    build: () => mcpSurfacePrompt(cell.surface, { ...cell.opts }),
  })),
  // The wave builders Codex found to be PURE after all — my earlier claim that all six remaining
  // `MiningWaveError` sites were inline was wrong: these three are named functions, and 08d's verifier
  // feeds BOTH of its wave sites. Each gained an `export` for this.
  // CONCRETE findings and the REAL lens roster, because a proxy reaches neither of the two regions
  // this builder appends. `group.findings.length` is 0 through a proxy, so `many` is false and the
  // grouped-findings block never renders; `findings.flatMap(...)` returns the stub's empty array, so
  // the per-finding block never renders; and spreading `lens.lines` yields nothing, so not one line of
  // `VERIFY_LENSES` was ever scanned. A bare agent path in any of those would have disabled isolation
  // for every real verifier wave with this file green.
  //
  // Both group sizes, because the builder words itself differently for one finding and for several and
  // only the multi arm renders the grouped block.
  ...(
    [
      { label: 'one finding', findings: 1 },
      { label: 'grouped findings', findings: 2 },
    ] as const
  ).flatMap((size) =>
    [...VERIFY_LENSES, null].map((lens) => ({
      label: `08d buildVerifyPrompt (${size.label}, lens ${lens?.id ?? 'generic'})`,
      build: () =>
        buildVerifyPrompt(
          permissive(),
          {
            key: 'src/app/handler.ts:42',
            findings: Array.from({ length: size.findings }, (_unused, i) => ({
              severity: 'high' as const,
              category: 'authorization',
              location: `src/app/handler.ts:${42 + i}`,
              impact: 'An unauthenticated caller reaches the admin route.',
              poc: `curl -i http://localhost:3000/admin/${i}`,
            })),
          },
          lens,
        ),
    })),
  ),
  // The REAL roster, one source per adversary. A synthetic `persona: 'Persona.'` stood here and scanned
  // none of the six production persona strings — and the registry's 08d mining source cannot reach them
  // either, because `assertReviewableChange` throws on the proxy's empty change set before the roster is
  // mapped (it is one of the 12 `unbuildable` entries). So an agent path added to any persona was
  // invisible from both directions.
  //
  // Real ids matter here beyond realism: this builder embeds a marker block interpolating the id
  // (`.claude/agents/${a.id}.md`), and a PROXY id renders `[[HAIVE_AGENT_DEFINITION:]]` with
  // `.claude/agents/.md` — a malformed marker `stripAgentGuidanceBlocks` cannot match, so the path
  // survives stripping and the source reports a FALSE positive. MEASURED both ways in an earlier round.
  //
  // `implementationFiles` is concrete so `changedFilesBlock` renders its POPULATED arm plus both
  // notices: through the bare proxy `files.length === 0` and it emitted only NO_CHANGE_SET_FALLBACK,
  // so the file list, the LINES note and the COVERAGE note were all dark.
  ...ADVERSARIES.map((adversary) => ({
    label: `08d buildAdversaryPrompt (${adversary.id})`,
    build: () =>
      buildAdversaryPrompt(
        adversary,
        permissive({
          implementationFiles: {
            files: ['src/app/handler.ts', 'src/lib/auth.ts'],
            total: 3,
            truncated: true,
            changedLines: { 'src/app/handler.ts': 'lines 12-18, 45' },
          },
        }),
      ),
  })),
  {
    label: '03-plan-sequence buildSequencePrompt (wave)',
    build: () => buildSequencePrompt(permissive(), permissive(), permissive()),
  },
  // 02-plan-coverage's re-decomposition wave. Its template was inline in `apply()` and is now a pure
  // builder so it can be reached here — the step declares only `tool_use`, so isolation applies to it.
  // Both section shapes are exercised, since `sectionBody: null` and `''` take different branches.
  {
    label: '02-plan-coverage buildCoverageRepairPrompt (wave, with section)',
    build: () =>
      buildCoverageRepairPrompt({
        subject: 'the plan node "Auth" (decomposition lost)',
        repairInstruction: 'Rebuild the missing subtree.',
        lostDetail: 'three children',
        sectionBody: 'The section body.',
        note: 'Keep it small.',
        maxChildren: 7,
        context: ['The plan as it stands (titles only):', '', '- Auth'],
      }),
  },
  // BOTH branches explicitly. These lines are spliced into the tester, adversary and verifier prompts,
  // and `permissive().appLogin.ok` is truthy — so every proxy-driven route through those builders
  // emitted the authenticated branch alone. Production emits the unauthenticated one whenever login is
  // absent or fails, and my exclusion of this helper as "covered via 08a" was true of half of it.
  {
    label: 'appAuthPromptLines (authenticated)',
    build: () => appAuthPromptLines({ attempted: true, ok: true, reason: '' }).join('\n'),
  },
  {
    label: 'appAuthPromptLines (unauthenticated)',
    build: () =>
      appAuthPromptLines({ attempted: true, ok: false, reason: 'no credentials' }).join('\n'),
  },
  {
    label: '02-plan-coverage buildCoverageRepairPrompt (wave, no section)',
    build: () =>
      buildCoverageRepairPrompt({
        subject: 'the source document section "Billing"',
        repairInstruction: 'No node in the plan covers this section.',
        lostDetail: null,
        sectionBody: null,
        note: null,
        maxChildren: 7,
        context: ['- Billing'],
      }),
  },
  // EXPLICIT fixtures, not a permissive proxy: `appReachPrompt` branches on
  // `reach.mode === 'sandbox_http'` and then on the URL scheme and `tlsTrusted`, and a proxy fails
  // every strict comparison against a literal — so a proxy scans the browser-only branch and nothing
  // else. This is the general limitation noted at `permissive` below, made concrete.
  ...(
    [
      { mode: 'sandbox_http', url: 'https://app.ddev.site', tlsTrusted: true },
      { mode: 'sandbox_http', url: 'https://app.ddev.site', tlsTrusted: false },
      { mode: 'sandbox_http', url: 'http://app-runner:3000', tlsTrusted: false },
      { mode: 'browser_only', url: 'https://app.ddev.site', tlsTrusted: false },
      { mode: 'none', url: null, tlsTrusted: false },
    ] as const
  ).map((reach) => ({
    label: `appReachPrompt (${reach.mode}${reach.tlsTrusted ? ', tls trusted' : ''})`,
    build: () =>
      appReachPrompt({ ...reach, addHosts: [] } as unknown as Parameters<typeof appReachPrompt>[0]),
  })),
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
  // `NO_VISION_BOUNDARY_PROMPT` is PRIVATE to `cli-adapters/model-capabilities.ts`, so neither it nor
  // its wrapper's name matches the export audit below — yet `dispatcher.ts:517` appends it AFTER the
  // isolation decision. Reached through the exported wrapper, with a fixture that satisfies its guard
  // (`resolveModelLimits` returns the limits only when `modelLimits.model` equals `provider.model`,
  // and the block is added only for `vision === false`). A permissive proxy takes the other branch and
  // returns the prompt untouched.
  {
    label: 'withModelCapabilityBoundary (no-vision block)',
    build: () =>
      withModelCapabilityBoundary('BASE PROMPT', {
        name: 'claude-code',
        model: 'vision-less-model',
        modelLimits: { model: 'vision-less-model', vision: false },
      } as unknown as Parameters<typeof withModelCapabilityBoundary>[1]),
  },
  // `adaptPromptForCliCapabilities` SUBSTITUTES text — the retrieval-protocol cell for the provider's
  // (LSP, rag) pair, and the agent-guidance arm — and it runs AFTER `agentIsolationApplies` has
  // decided. So a variant that named an agent directory would reach an invocation whose mask hides
  // it. Excluding it as "the rewriter the scan runs" was wrong: the scan never calls it.
  //
  // Only the ISOLATED arms are scanned. The pointer arm deliberately names the agent file and runs
  // only when isolation is OFF, so scanning it would add a positive that says nothing about masking.
  ...(
    [
      { supportsLsp: true, ragWired: true },
      { supportsLsp: true, ragWired: false },
      { supportsLsp: false, ragWired: true },
      { supportsLsp: false, ragWired: false },
    ] as const
  ).flatMap((axes) =>
    [
      { withBody: true, label: 'pasted body' },
      { withBody: false, label: 'embedded fallback' },
    ].map(({ withBody, label }) => ({
      label: `adaptPromptForCliCapabilities (lsp=${axes.supportsLsp} rag=${axes.ragWired}, ${label})`,
      build: () =>
        adaptPromptForCliCapabilities(
          [
            agentDefinitionGuidance(
              'peer-reviewer',
              'Follow .claude/agents/peer-reviewer.md if it exists.',
            ),
            ...buildRetrievalGuidance({ supportsLsp: true, ragWired: true }),
          ].join('\n'),
          {
            ...axes,
            projectAgentsDir: '.claude/agents',
            agentFileFormat: 'markdown',
            isolated: true,
            agentBodies: withBody
              ? { 'peer-reviewer': '# Peer reviewer\n\nScore every dimension.' }
              : {},
          },
        ),
    })),
  ),
];

/**
 * Every exported prompt-like symbol this file SCANS, keyed `path#symbol` relative to the worker's
 * `src/`. File-qualified rather than by bare identifier: two modules exporting the same name collapse
 * into ONE entry under a name key, so the second source silently inherits the first's ruling and is
 * never scanned. The cost is that moving a file edits this list, which is the point — the audit then
 * reports the old key stale and the new one unclassified instead of carrying the ruling across.
 */
const SCANNED_PROMPT_EXPORTS = [
  'step-engine/steps/workflow/08c-code-review.ts#buildRefutePrompt',
  'step-engine/steps/plan/01-plan-build.ts#buildExpandPrompt',
  'step-engine/steps/workflow/_agent-selector.ts#buildAgentSelectorPrompt',
  'step-engine/steps/kb-author/01-enrich.ts#buildEnrichPrompt',
  'step-engine/dag-executor.ts#reviewerPrompt',
  'step-engine/dag-executor.ts#advisorPrompt',
  'step-engine/dag-executor.ts#replannerPrompt',
  'step-engine/dag-executor.ts#fixCoderPrompt',
  'step-engine/git-merge.ts#buildMergeFixPrompt',
  'step-engine/steps/_global-kb-digest.ts#globalKbDigestPrompt',
  'sandbox/mcp-surface.ts#mcpSurfacePrompt',
  'queues/cli-exec/app-reach.ts#appReachPrompt',
  'step-engine/step-runner.ts#buildStepSummaryPrompt',
  'step-engine/step-runner.ts#buildAgentMiningSummaryPrompt',
  'repo/worktree-git-boundary.ts#WORKTREE_GIT_BOUNDARY_PROMPT',
  'repo/ddev-generated-boundary.ts#DDEV_GENERATED_BOUNDARY_PROMPT',
  'step-engine/steps/workflow/_prompt-defect.ts#PROMPT_DEFECT_INSTRUCTION',
  'step-engine/steps/_retrieval-guidance.ts#adaptPromptForCliCapabilities',
  'step-engine/steps/workflow/08d-adversarial-qa.ts#buildVerifyPrompt',
  'step-engine/steps/workflow/08d-adversarial-qa.ts#buildAdversaryPrompt',
  'step-engine/steps/plan/03-plan-sequence.ts#buildSequencePrompt',
  'step-engine/steps/plan/02-plan-coverage.ts#buildCoverageRepairPrompt',
  'step-engine/steps/workflow/_app-auth.ts#appAuthPromptLines',
  // NOT `withModelCapabilityBoundary`: this list is the audit's bookkeeping — symbols the sweep below
  // can actually see — and that wrapper contains no "prompt", so listing it here reads as a stale
  // entry. It is scanned as a SOURCE in NAMED_PROMPT_BUILDERS, which is the distinction: a source the
  // audit cannot name is still a source.
];

/**
 * Exported prompt-like symbols deliberately NOT scanned, each with the reason, keyed the same
 * `path#symbol` way. The completeness case below fails if a new one appears in neither list — which is
 * what ends the round-by-round discovery that produced this file: llm, then loop, then mining, then
 * waves, then dag-executor's direct dispatches were each found one review at a time.
 */
const NOT_A_DISPATCHED_PROMPT: Record<string, string> = {
  'cli-adapters/antigravity.ts#antigravityStdinPrompt':
    'wraps an already-built prompt for stdin; adds no text of its own',
  'cli-adapters/prompt-delivery.ts#deliverPrompt':
    'delivery mechanism (argv vs stdin), not a builder',
  'queues/cli-exec/stream-log-retention.ts#expiredPromptFilter':
    'a SQL predicate for stream-log retention',
  'step-engine/steps/workflow/_prompt-defect.ts#parsePromptDefects': 'a parser of agent OUTPUT',
  'sub-agent-emulator/native-mode.ts#assembleNativePrompt':
    'sub-agent assembly — `input.kind` is not `prompt` there, so agentIsolationApplies excludes it',
  'step-engine/steps/onboarding/06_5-agent-discovery.ts#buildAgentDiscoveryPrompt':
    "06_5's llm builder, already scanned through the registry",
  'cli-adapters/prompt-delivery.ts#PROMPT_ARGV_LIMIT_BYTES':
    'a byte limit for argv delivery, not text',
  'cli-adapters/prompt-delivery.ts#PROMPT_FILE_PATH':
    'the in-container path a long prompt is written to, not text',
  'step-engine/steps/_retrieval-guidance.ts#promptCarriesPastedPersona':
    'a predicate ABOUT a prompt; contributes no text',
  'step-engine/steps/workflow/_prompt-defect.ts#promptDefectFingerprint':
    'a fingerprint over a defect, not prompt text',
  'step-engine/steps/workflow/11e-prompt-guidance.ts#promptGuidanceStep':
    '11e-prompt-guidance StepDefinition — already scanned through the registry; it matches only ' +
    'because the step is NAMED for prompts',
  // The four augmenters take a `db` and RETURN THE PROMPT UNCHANGED when there is no data — no
  // ledger entries, no attachments, no learned guidance, no stored terseness level. Scanning them
  // with permissive inputs would therefore exercise none of their own text and report a vacuous
  // clean, which is the failure mode this file has already been corrected for twice. Their added
  // text is data-derived (filenames, stored guidance) rather than a static template, so a fixed bare
  // agent path cannot live in the part that varies; a path in their unconditional wrapper text is a
  // real residual gap and is recorded as one here.
  'step-engine/task-ledger.ts#augmentPromptWithLedger':
    'data-derived; returns the prompt unchanged with no ledger entries',
  'step-engine/attachments-context.ts#augmentPromptWithAttachments':
    'data-derived; returns the prompt unchanged with no attachments',
  'step-engine/guidance-context.ts#augmentPromptWithLearnedGuidance':
    'data-derived; returns the prompt unchanged with no guidance',
  'step-engine/terseness-context.ts#augmentPromptWithTerseness':
    'reads a config value; returns the prompt unchanged when unset',
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
      // One source per ROLE, not one per step and not a sample of one iteration. Four loop steps give
      // an iteration two different prompts: 05, 07b and 08a on PARITY (`iteration % 2 === 0`, so
      // reviewer/validator/tester on even and corrector/fixer on odd) and 07a on `iteration === 0`.
      // A fixed `iteration: 1` built only the odd arm, so a bare agent path in a re-review prompt
      // would have disabled isolation in production with every assertion here still passing.
      //
      // The roles come from the loop's own `resolveRole`, so this cannot drift from the step's rule.
      // Where there is none, 0 and 1 are still both built: 08b and 09_5 branch on `iteration === 0`
      // inside apply and may grow the same split in their prompt.
      const loop = def.loop!;
      const cap = Math.max(1, Math.min(loop.maxIterations ?? 1, 4));
      const byRole = new Map<string, number>();
      for (let n = 0; n <= cap; n += 1) {
        const role = loop.resolveRole?.(n) ?? (n === 0 ? 'first' : 'later');
        if (!byRole.has(role)) byRole.set(role, n);
      }
      for (const [role, n] of byRole) {
        out.push({
          label: `${id} (loop iteration ${n}/${role})`,
          build: () =>
            iteration({
              detected: permissive(),
              formValues: permissive(),
              iteration: n,
              previousIterations: [],
            }),
        });
      }
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
          return dispatches.map((d, i) => ({
            key: `${i}:${String(d.agentId ?? '')}`,
            prompt: d.prompt,
          }));
        },
      });
    }
  }
  return out;
}

/**
 * One source's verdicts. Its own function so the fan-out case below can exercise it on a SYNTHETIC
 * multi-dispatch source: MEASURED, every real mining source produces at most ONE dispatch under the
 * permissive inputs (`10_8-plan-build` and `01-plan-build` yield `plan-root`; the rest yield none or
 * throw), so per-invocation keying would otherwise be structurally correct and never exercised — the
 * vacuity this file has already been corrected for twice.
 */
async function classifySource(source: PromptSource): Promise<Scanned> {
  const out: Scanned = { named: [], clean: [], unbuildable: [] };
  let entries: BuiltPrompt[];
  try {
    entries = builtEntries(source, await source.build());
  } catch {
    out.unbuildable.push(source.label);
    return out;
  }
  // A mining step that selects no agent under empty inputs produced no prompt to scan — not the same
  // thing as a clean one, so it is reported rather than counted as covered. Reported by SOURCE,
  // because there is no invocation to key on.
  if (entries.length === 0) {
    out.unbuildable.push(source.label);
    return out;
  }
  // One verdict per INVOCATION, never one per source: each of these is its own `resolveTaskDispatch`
  // call, so collapsing a fan-out with `.some(...)` would let a path in one sibling hide behind an
  // expected positive in another.
  for (const entry of entries) {
    // Exactly what the dispatch rule does: strip Haive's own marker blocks, then scan what is left.
    const names = promptNamesAgentPath(stripAgentGuidanceBlocks(entry.prompt), SANDBOX_WORKDIR);
    if (names) out.named.push(entry.key);
    else out.clean.push(entry.key);
  }
  return out;
}

async function scanBuiltPrompts(): Promise<Scanned> {
  const out: Scanned = { named: [], clean: [], unbuildable: [] };
  for (const source of promptSources()) {
    const one = await classifySource(source);
    out.named.push(...one.named);
    out.clean.push(...one.clean);
    out.unbuildable.push(...one.unbuildable);
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
    // Matched on the SHAPE `(loop iteration <n>/<role>)`, because the loop path now contributes one
    // source per role rather than one per step.
    expect(labels.some((l) => /\(loop iteration \d+\/.+\)$/.test(l))).toBe(true);
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
    //     `agentIsolationApplies` already excludes it two conditions earlier. Its paths are moot. Both
    //     of its loop roles name one, which is why it appears twice.
    //
    // What enumerating the loop ROLES showed, and it is the reassuring answer rather than a new hole:
    // the even/first arms of 05, 07b, 08a and 07a — reviewer, validator, tester, simplifier, none of
    // which this scan built while it sampled `iteration: 1` — are all CLEAN. No step joined this list.
    //
    // An explicit list rather than a snapshot: `vitest -u` rewrites a snapshot silently.
    expect(named).toEqual([
      '06_5-agent-discovery',
      '09_5-skill-generation',
      '09_5-skill-generation (loop iteration 0/first)',
      '09_5-skill-generation (loop iteration 1/later)',
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
      let entries: BuiltPrompt[];
      try {
        entries = builtEntries(source, await source.build());
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (promptNamesAgentPath(entry.prompt, SANDBOX_WORKDIR)) unstripped.push(entry.key);
        const stripped = stripAgentGuidanceBlocks(entry.prompt);
        // Keyed per invocation, so a failure names the dispatch rather than only its step.
        expect(
          stripped.trim().length,
          `${entry.key}: stripping emptied the prompt`,
        ).toBeGreaterThan(0);
        if (stripped.length < entry.prompt.length) markerRemoved += 1;
      }
    }
    expect(markerRemoved).toBeGreaterThan(0);
    expect(unstripped.length).toBeGreaterThan(0);
  });

  it('reports what it still cannot reach, and how much it covers', async () => {
    const { clean, named, unbuildable } = await scanBuiltPrompts();
    // Coverage is pinned so that WEAKENING is visible: if builders start rejecting the permissive
    // inputs, this drops and the guard shrinks without anyone noticing otherwise.
    // MEASURED 2026-09-22: 102 clean + 4 named = 106 built, 12 unreachable. The floor sat at 40 while
    // the loop path contributed one source per STEP, the verifier one source per proxy and the adversary
    // one synthetic persona; per role, per lens and per persona they contribute 12, 8 and 6. A floor
    // under half the real number is a ratchet that never catches anything, so it is re-measured
    // whenever sources are added.
    expect(clean.length + named.length).toBeGreaterThanOrEqual(106);
    // What remains unreachable is listed rather than hidden — a mining step that selects nothing under
    // empty inputs, or a builder that rejects them outright.
    // Held at the measured 12, so a NEW unreachable source has to be acknowledged rather than absorbed
    // into slack. One-directional on purpose: something becoming reachable must never fail this.
    expect(unbuildable.length).toBeLessThanOrEqual(12);
    // Every NAMED builder must actually build, or the coverage claimed by listing it is fiction.
    // This is the check that would have caught a hand-added source silently landing in the
    // unreachable bucket while the counts still looked healthy.
    const namedLabels = NAMED_PROMPT_BUILDERS.map((s) => s.label);
    expect(unbuildable.filter((label) => namedLabels.includes(label))).toEqual([]);
    // Stated so nobody reads this file as exhaustive. All eight `MiningWaveError` sites have their
    // prompt TEMPLATE scanned above (see the enumeration on NAMED_PROMPT_BUILDERS). What is still
    // unscanned is what `augmentPromptWithAttachments` adds to 02-plan-coverage's two convergence
    // waves — data-derived filenames, in a module carrying no agent-directory literal. Executing the
    // `apply()` bodies to reach it is not the answer: several applies write files, which a unit test
    // must not do.
    expect(named).not.toContain('08c-code-review buildRefutePrompt (wave 2)');
  });

  it('actually RENDERS the verifier regions a proxy left dark', async () => {
    // A fixture that reaches nothing passes every assertion in this file, so the three regions the
    // permissive proxy skipped are named explicitly here. Without this the previous fixture looked
    // like coverage of `buildVerifyPrompt` while scanning only its unconditional prose.
    const built = (
      await Promise.all(
        promptSources()
          .filter((s) => s.label.startsWith('08d buildVerifyPrompt'))
          .map(async (s) => builtEntries(s, await s.build())),
      )
    ).flat();
    // Both group sizes times three lenses plus the generic arm.
    expect(built.length).toBe(8);
    const all = built.map((b) => b.prompt).join('\n\n');

    // 1. every lens's own text, straight from the production roster.
    for (const lens of VERIFY_LENSES) {
      expect(all, `lens ${lens.id} never rendered`).toContain(lens.lines[0]);
    }
    // 2. the per-finding block, from `findings.flatMap` — the stub returned [] for this.
    expect(all).toContain('Proof of concept: curl -i http://localhost:3000/admin/0');
    expect(all).toContain('Severity as filed: high');
    // 3. the grouped arm, which needs `findings.length > 1` and so never rendered through a proxy.
    expect(all).toContain('These 2 findings were grouped because they name the same place in the');
  });

  it('RENDERS every real adversary persona and the populated change-set block', async () => {
    const built = (
      await Promise.all(
        promptSources()
          .filter((s) => s.label.startsWith('08d buildAdversaryPrompt'))
          .map(async (s) => builtEntries(s, await s.build())),
      )
    ).flat();
    expect(built.length).toBe(ADVERSARIES.length);
    const all = built.map((b) => b.prompt).join('\n\n');

    // Each persona's own words, straight from the production roster.
    for (const adversary of ADVERSARIES) {
      expect(all, `persona ${adversary.id} never rendered`).toContain(adversary.persona);
    }
    // `changedFilesBlock`'s three arms, none of which a bare proxy reaches.
    expect(all).toContain('- src/app/handler.ts — lines 12-18, 45');
    expect(all).toContain('LINES: the note after a file is the part of it THIS change wrote');
    expect(all).toContain('COVERAGE: the list above is 2 of 3 changed files.');
  });

  it('strips ONLY the marker blocks — the prose around them survives', () => {
    // The case above asserts a stripped prompt is non-EMPTY, which Codex correctly called insufficient:
    // a stripper that swallowed most of a prompt but left a few characters would satisfy it while the
    // production path scan had quietly stopped examining the text it exists to examine — the dispatcher
    // strips with this same function, so an over-strip is wrong in production too, not only here.
    //
    // The hazard is specific rather than hypothetical. `AGENT_GUIDANCE_PATTERN` spans newlines with
    // `[\s\S]*?`, so only its NON-GREEDINESS keeps two marker blocks two matches; a greedy span would
    // match from the first block's start to the last block's end and take every line between them.
    // This is also the only coverage `stripAgentGuidanceBlocks` has anywhere — `_retrieval-guidance.
    // test.ts` does not mention it.
    const marker = (id: string) =>
      `[[HAIVE_AGENT_DEFINITION:${id}]]\nFollow .claude/agents/${id}.md if it exists.\n[[HAIVE_AGENT_DEFINITION_END]]`;
    const before = 'Review the diff and report blocking defects only.';
    const between = 'Then score the change against the review dimensions.';
    const after = 'Return one JSON object and nothing else.';
    const prompt = [
      before,
      marker('peer-reviewer'),
      between,
      marker('security-auditor'),
      after,
    ].join('\n\n');

    const stripped = stripAgentGuidanceBlocks(prompt);
    // Known non-marker content, on all three sides of the two blocks.
    expect(stripped).toContain(before);
    expect(stripped).toContain(between);
    expect(stripped).toContain(after);
    expect(stripped).not.toContain('HAIVE_AGENT_DEFINITION');

    // And the pair that gives the whole tripwire its meaning: the marked prompt DOES name an agent
    // path, and stripping is what makes it stop. If the stripper ever removed more than the blocks,
    // the three assertions above fail before this one can pass for the wrong reason.
    expect(promptNamesAgentPath(prompt, SANDBOX_WORKDIR)).toBe(true);
    expect(promptNamesAgentPath(stripped, SANDBOX_WORKDIR)).toBe(false);
  });

  it('gives a FAN-OUT one verdict per dispatch, not one per source', async () => {
    // The regression this pins: `dispatchMiningAgents` (`step-runner.ts:1477`) loops over the
    // dispatches and hands each prompt to `resolveTaskDispatch` on its own, so two siblings can land
    // on opposite sides of the isolation rule. A source-level `.some(...)` reported ONE verdict for
    // the pair — so a path added to a clean sibling changed nothing once another sibling was already
    // an expected positive, and a path removed from one while another stayed positive changed nothing
    // either. Both directions are silent, which is what makes it a tripwire defect rather than a
    // cosmetic one.
    //
    // Synthetic because no real mining source fans out under the permissive inputs (measured on
    // `classifySource`). The prompts are the two cases the rule distinguishes, using the whole-segment
    // form `promptNamesAgentPath` matches from the mount root.
    const fanOut: PromptSource = {
      label: 'synthetic fan-out',
      build: async () => [
        {
          key: '0:clean-sibling',
          prompt: 'Summarise the change. Do not open any definition files.',
        },
        {
          key: '1:names-a-path',
          prompt: 'Read .claude/agents/security-auditor.md before scoring.',
        },
      ],
    };

    const { named, clean, unbuildable } = await classifySource(fanOut);
    expect(named).toEqual(['synthetic fan-out [1:names-a-path]']);
    expect(clean).toEqual(['synthetic fan-out [0:clean-sibling]']);
    expect(unbuildable).toEqual([]);
    // Under the collapsed form the pair produced exactly one entry; two is the whole point.
    expect(named.length + clean.length).toBe(2);
  });

  it('classifies every EXPORTED prompt symbol — private fragments are a stated gap', async () => {
    // Scope, stated precisely because an earlier version of this comment implied exhaustiveness and
    // was wrong: this audits EXPORTED symbols whose name contains "prompt". Prompt text living in a
    // PRIVATE constant is invisible to it, and such text exists — `NO_VISION_BOUNDARY_PROMPT` is
    // private to `cli-adapters/model-capabilities.ts` and appended at `dispatcher.ts:517`, with a
    // wrapper whose own name contains no "prompt" either. That one is scanned above through its
    // wrapper; another private fragment reached by a differently-named wrapper would evade this audit,
    // and no name-based rule can close that. It is a real boundary, not an oversight.
    // This case exists because of how this file grew: llm, then loop iterations, then mining, then
    // mining waves, then dag-executor's direct dispatches were each found ONE REVIEW AT A TIME, and
    // every intermediate version looked complete. Enumerating the symbols ends that loop — a new
    // exported prompt builder now fails here until someone either scans it or excludes it by name.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    // No trailing slash: `walk` joins with its own, and a doubled separator would leave every relative
    // path below starting with one — a `path#symbol` key that matches nothing in either list.
    const srcRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    // Keyed `path#symbol`, never by the identifier alone: two modules exporting the same prompt-like
    // name are TWO sources, and a name key merges them into one — whichever was classified first then
    // vouches for a module nothing has read.
    const exported = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const rel = file.slice(srcRoot.length + 1);
      // Case-INSENSITIVE, and matched on the whole identifier rather than a `Prompt` substring
      // pattern: the repository names constant blocks in SCREAMING_CASE (`WORKTREE_GIT_BOUNDARY_PROMPT`,
      // `DDEV_GENERATED_BOUNDARY_PROMPT`), which a case-sensitive `\w*Prompt\w*` misses entirely — so
      // the first version of this "exhaustive" audit was not.
      for (const m of src.matchAll(/^export (?:async )?function (\w+)\s*\(/gm)) {
        if (/prompt/i.test(m[1]!)) exported.add(`${rel}#${m[1]!}`);
      }
      for (const m of src.matchAll(/^export const (\w+)\s*[=:]/gm)) {
        if (/prompt/i.test(m[1]!)) exported.add(`${rel}#${m[1]!}`);
      }
    }

    const scanned = new Set(SCANNED_PROMPT_EXPORTS);
    const unclassified = [...exported]
      .filter((key) => !scanned.has(key) && !(key in NOT_A_DISPATCHED_PROMPT))
      .sort();
    expect(unclassified).toEqual([]);

    // No stale bookkeeping either: every key claimed as scanned or excluded must still exist. A moved
    // file therefore fails BOTH assertions, which is the honest reading — the ruling was made about a
    // module at a path, and the path is half of what was ruled on.
    const stale = [...scanned, ...Object.keys(NOT_A_DISPATCHED_PROMPT)]
      .filter((key) => !exported.has(key))
      .sort();
    expect(stale).toEqual([]);

    // The sweep found the tree, not an empty directory.
    expect(exported.size).toBeGreaterThan(15);
  });
});
