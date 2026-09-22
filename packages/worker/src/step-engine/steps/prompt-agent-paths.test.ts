import { describe, expect, it } from 'vitest';
import { promptNamesAgentPath } from '@haive/shared';
import { StepRegistry } from '../registry.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { stripAgentGuidanceBlocks } from './_retrieval-guidance.js';
import { registerAllSteps } from './index.js';

/**
 * Verification item 2's tripwire: which BUILT-IN prompts name an agent directory once Haive's own
 * marker blocks are stripped — i.e. which ones `agentIsolationApplies` refuses to isolate.
 *
 * It has to be the BUILT prompt, not the source file. A grep over `steps/**` matches 23 files,
 * because the source also carries prose in comments, `agentDefinitionGuidance(...)` calls whose
 * rendered block is stripped before the scan, and code that WRITES those files
 * (`_agent-templates.ts`, `_scope.ts`). None of those end isolation; a bare path in prompt text does.
 *
 * THREE dispatch paths reach the isolation rule, and an earlier version of this file scanned only the
 * first:
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
 * With all three paths and permissive inputs, 40+ prompts are actually built and scanned, and the
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
 * iteration is empty, and string interpolation yields `''`. `then` and `toJSON` are deliberately
 * undefined — a thenable would make `await` hang, and a `toJSON` that returned another proxy would
 * send `JSON.stringify` into recursion.
 */
function permissive(): never {
  const target = function noop(): void {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON') return undefined;
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

/** Every prompt production can dispatch, across all three paths. */
function promptSources(): PromptSource[] {
  const out: PromptSource[] = [];
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
    expect(unbuildable.length).toBeLessThanOrEqual(12);
  });
});
