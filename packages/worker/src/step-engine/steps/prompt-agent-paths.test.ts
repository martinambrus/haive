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
import { buildAdversaryPrompt, buildVerifyPrompt } from './workflow/08d-adversarial-qa.js';
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

interface PromptSource {
  label: string;
  build: () => string | Promise<string[]>;
}

/**
 * A FOURTH path: prompts thrown as a later mining wave (`MiningWaveError.dispatches`), which
 * `step-runner` re-dispatches through `resolveTaskDispatch` exactly like a first wave.
 *
 * Eight wave sites exist across five steps (08c, 08d, 01-plan-build, 02-plan-coverage,
 * 03-plan-sequence). SIX are now scanned through named builders — 08c's refuter, plan-build's expand,
 * 08d's verifier (which feeds BOTH of its wave sites) and 03-plan-sequence's. An earlier version of
 * this comment claimed the remaining six "assemble their dispatch arrays inline" and was WRONG: I had
 * read the throw sites, seen array construction, and not looked at what built the prompts inside.
 * Three were plain functions needing only an `export`.
 *
 * TWO remain out of reach, both in 02-plan-coverage: one builds its prompt through
 * `augmentPromptWithAttachments` (async, needs a database) and one is assembled inline in `apply()`.
 * Reaching those means executing `apply()` bodies, and several applies write files — a side effect a
 * unit test must not have. That is the residual gap, restated accurately in the coverage case.
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
  {
    label: '08d buildVerifyPrompt (wave)',
    build: () => buildVerifyPrompt(permissive(), permissive(), permissive()),
  },
  {
    // A REAL id, not a proxy. This builder embeds a marker block whose text interpolates the id
    // (`.claude/agents/${a.id}.md`), and a proxy id renders `[[HAIVE_AGENT_DEFINITION:]]` plus
    // `.claude/agents/.md` — a malformed marker that `stripAgentGuidanceBlocks` cannot match, so the
    // path survives stripping and the source reports a FALSE positive. MEASURED: with the proxy this
    // showed up in `named`; with a real id it does not, which is production behaviour.
    label: '08d buildAdversaryPrompt',
    build: () =>
      buildAdversaryPrompt(
        {
          id: 'security-auditor',
          title: 'Security auditor',
          persona: 'Persona.',
        } as unknown as Parameters<typeof buildAdversaryPrompt>[0],
        permissive(),
      ),
  },
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
  'adaptPromptForCliCapabilities',
  'buildVerifyPrompt',
  'buildAdversaryPrompt',
  'buildSequencePrompt',
  'buildCoverageRepairPrompt',
  'appAuthPromptLines',
  // NOT `withModelCapabilityBoundary`: this list is the audit's bookkeeping — names the sweep below
  // can actually see — and that wrapper contains no "prompt", so listing it here reads as a stale
  // entry. It is scanned as a SOURCE in NAMED_PROMPT_BUILDERS, which is the distinction: a source the
  // audit cannot name is still a source.
];

const NOT_A_DISPATCHED_PROMPT: Record<string, string> = {
  antigravityStdinPrompt: 'wraps an already-built prompt for stdin; adds no text of its own',
  deliverPrompt: 'delivery mechanism (argv vs stdin), not a builder',
  expiredPromptFilter: 'a SQL predicate for stream-log retention',
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
    // KNOWN RESIDUAL GAP, stated so nobody reads this file as exhaustive. SIX of the eight
    // `MiningWaveError` sites are scanned above through named builders (08c's refuter, plan-build's
    // expand, 08d's verifier for both of its sites, 03-plan-sequence's). TWO remain, both in
    // 02-plan-coverage: one builds its prompt through `augmentPromptWithAttachments` (async, needs a
    // database) and one is assembled inline in `apply()`. Reaching those means executing `apply()`
    // bodies, and several applies write files — a side effect a unit test must not have.
    expect(named).not.toContain('08c-code-review buildRefutePrompt (wave 2)');
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
