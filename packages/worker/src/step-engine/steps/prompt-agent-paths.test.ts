import { describe, expect, it } from 'vitest';
import { promptNamesAgentPath } from '@haive/shared';
import { StepRegistry } from '../registry.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { stripAgentGuidanceBlocks } from './_retrieval-guidance.js';
import { registerAllSteps } from './index.js';

/**
 * Verification item 2's tripwire: among the BUILT-IN prompt builders, which ones name an agent
 * directory once Haive's own marker blocks are stripped — i.e. which ones `agentIsolationApplies`
 * refuses to isolate.
 *
 * It has to be the BUILT prompt, not the source file. A grep over `steps/**` matches 23 files,
 * because the source also carries prose in comments, `agentDefinitionGuidance(...)` calls whose
 * rendered block is stripped before the scan, and code that WRITES those files
 * (`_agent-templates.ts`, `_scope.ts`). None of those end isolation; a bare path in prompt text does.
 *
 * So the registry is booted for real — through `registerAllSteps`, the production entry point — and
 * BOTH of a step's prompt builders are called: `llm.buildPrompt` and, where a loop defines one,
 * `loop.buildIterationPrompt`. That is possible because neither takes a live `StepContext`, only a
 * small args bag (`{ detected, formValues, iteration?, previousIterations? }`): no database, no task,
 * no repository.
 *
 * A builder that throws on synthetic args is REPORTED rather than silently skipped — the count is
 * asserted below, so a change that makes more builders unbuildable weakens this guard visibly
 * instead of quietly.
 */
function bootRegistry(): StepRegistry {
  const registry = new StepRegistry();
  // The PRODUCTION registration, never a hand-kept list of workflow types. This file first rolled its
  // own and omitted `registerEnvReplicateSteps` while claiming to cover every type: env-replicate
  // declares no llm phase today, so the scan passed, and any prompt added there would have escaped
  // the guard silently. `registerAllSteps` also runs the four boot sanity checks, so their drift
  // surfaces here too.
  registerAllSteps(registry);
  return registry;
}

interface Scanned {
  named: string[];
  clean: string[];
  unbuildable: string[];
}

/**
 * Every prompt production can DISPATCH, which is two builders per step and not one.
 *
 * `step-runner.ts:707` routes a loop pass to `stepDef.loop.buildIterationPrompt(...)` instead of
 * `llm.buildPrompt(...)` whenever `upcomingIteration > 0 || truncationRetries > 0` — so 05, 07a, 07b,
 * 08a and 09_5 each have an iteration-only prompt that the isolation rule evaluates and that scanning
 * `llm` alone never sees. Missing it was the whole point of this file being wrong once already.
 */
interface PromptSource {
  label: string;
  build: () => string;
}

function promptSources(): PromptSource[] {
  const out: PromptSource[] = [];
  for (const def of bootRegistry().all()) {
    const id = def.metadata.id;
    const llm = def.llm;
    if (llm)
      out.push({ label: id, build: () => llm.buildPrompt({ detected: {}, formValues: {} }) });
    const iteration = def.loop?.buildIterationPrompt;
    if (iteration) {
      out.push({
        label: `${id} (loop iteration)`,
        build: () =>
          iteration({ detected: {}, formValues: {}, iteration: 1, previousIterations: [] }),
      });
    }
  }
  return out;
}

function scanBuiltPrompts(): Scanned {
  const out: Scanned = { named: [], clean: [], unbuildable: [] };
  for (const source of promptSources()) {
    let prompt: string;
    try {
      prompt = source.build();
    } catch {
      out.unbuildable.push(source.label);
      continue;
    }
    // Exactly what the dispatch rule does: strip Haive's own marker blocks, then scan what is left.
    if (promptNamesAgentPath(stripAgentGuidanceBlocks(prompt), SANDBOX_WORKDIR)) {
      out.named.push(source.label);
    } else {
      out.clean.push(source.label);
    }
  }
  out.named.sort();
  out.clean.sort();
  out.unbuildable.sort();
  return out;
}

describe('built-in prompt builders vs agentIsolationApplies', () => {
  it('boots every workflow type, so no registered step escapes the scan', () => {
    const registry = bootRegistry();
    const ids = registry.all().map((d) => d.metadata.id);
    // A real boot rather than a hand-kept list: the point of registering is that a step added to any
    // index.ts is scanned below without this file being touched.
    expect(ids.length).toBeGreaterThan(40);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('07-generate-files');
    expect(ids).toContain('08c-code-review');
  });

  it('finds NO buildable prompt that names an agent path outside a marker block', () => {
    const { named, clean } = scanBuiltPrompts();
    // MEASURED 2026-09-22, not taken from the plan. An entry here is a step whose prompt would NOT be
    // isolated — possibly correct, but a decision rather than a surprise. Asserted as an explicit
    // list rather than a snapshot: `vitest -u` rewrites a snapshot silently, and the whole point of
    // this case is that a new match has to be typed out by a person.
    expect(named).toEqual([]);
    // Coverage is asserted so that WEAKENING it is visible: if builders start throwing on synthetic
    // args, this number drops and the guard shrinks without anyone noticing otherwise.
    expect(clean.length).toBeGreaterThanOrEqual(18);
    // The loop-iteration path is IN the scan. Asserted directly because scanning `llm` alone was a
    // real gap in this file: `step-runner.ts:707` dispatches `buildIterationPrompt` for any pass past
    // the first, so dropping that branch from `promptSources` would silently stop covering five steps.
    expect(clean.some((label) => label.endsWith('(loop iteration)'))).toBe(true);
  });

  it('is not vacuous: markers are present, removed, and the rest of the prompt SURVIVES', () => {
    // `named: []` proves nothing on its own, and there are TWO ways it could be empty for the wrong
    // reason. Both are checked here:
    //
    //   1. the scan reads nothing at all — then no prompt would name a path even UNSTRIPPED;
    //   2. `stripAgentGuidanceBlocks` swallows the whole prompt — then the scan reads empty strings,
    //      every builder classifies clean, and check 1 STILL passes because it reads the unstripped
    //      text. An earlier version of this case tested only 1 and claimed to have ruled out both.
    const unstripped: string[] = [];
    let markerRemoved = 0;
    for (const source of promptSources()) {
      let prompt: string;
      try {
        prompt = source.build();
      } catch {
        continue;
      }
      if (promptNamesAgentPath(prompt, SANDBOX_WORKDIR)) unstripped.push(source.label);
      const stripped = stripAgentGuidanceBlocks(prompt);
      // (2) Every scanned prompt still carries content after stripping. This is what makes the
      // `named` result a reading of prompt TEXT rather than of an empty string.
      expect(
        stripped.trim().length,
        `${source.label}: stripping emptied the prompt`,
      ).toBeGreaterThan(0);
      if (stripped.length < prompt.length) markerRemoved += 1;
    }
    // Stripping is doing work rather than passing every prompt through untouched.
    expect(markerRemoved).toBeGreaterThan(0);
    // (1) The scan sees real prompt text: unstripped, some prompts DO name an agent path.
    expect(unstripped.length).toBeGreaterThan(0);
  });

  it('reports which builders it could NOT reach, 06_5 and 09_5 among them', () => {
    const { unbuildable } = scanBuiltPrompts();
    // The honest limit of this file, and the reason the plan's own phrasing of this assertion — "only
    // 06_5 and 09_5 match" — is NOT established here: both cast `args.detected` to a rich typed shape
    // and dereference it (`buildSkillPrompt(args.detected as SkillGenDetect, …)`), so an empty args
    // bag throws before any prompt exists. Bespoke `detected` fixtures were considered and rejected:
    // they would drift with each step's detect payload and fail for reasons unrelated to agent paths.
    expect(unbuildable).toContain('06_5-agent-discovery');
    expect(unbuildable).toContain('09_5-skill-generation');
    // Pinned so a step MOVING between the two buckets — newly buildable, or newly throwing — shows up
    // as a diff here. That is what keeps a new step from landing unexamined in either direction.
    expect(unbuildable.length).toBe(26);
  });
});
