import { describe, expect, it } from 'vitest';
import { promptNamesAgentPath } from '@haive/shared';
import { StepRegistry } from '../registry.js';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { stripAgentGuidanceBlocks } from './_retrieval-guidance.js';
import { registerOnboardingSteps } from './onboarding/index.js';
import { registerOnboardingUpgradeSteps } from './onboarding-upgrade/index.js';
import { registerWorkflowSteps } from './workflow/index.js';
import { registerPlanSteps } from './plan/index.js';
import { registerKbAuthorSteps } from './kb-author/index.js';
import { registerRunAppSteps } from './run-app/index.js';

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
 * So the registry is booted for real — every workflow type's own `register*Steps` — and each `llm`
 * spec's `buildPrompt` is called. That is possible because `buildPrompt` takes `LlmBuildArgs`
 * (`{ detected, formValues, iteration? }`) rather than a live `StepContext`: no database, no task,
 * no repository.
 *
 * A builder that throws on synthetic args is REPORTED rather than silently skipped — the count is
 * asserted below, so a change that makes more builders unbuildable weakens this guard visibly
 * instead of quietly.
 */
function bootRegistry(): StepRegistry {
  const registry = new StepRegistry();
  registerOnboardingSteps(registry);
  registerOnboardingUpgradeSteps(registry);
  registerWorkflowSteps(registry);
  registerPlanSteps(registry);
  registerKbAuthorSteps(registry);
  registerRunAppSteps(registry);
  return registry;
}

interface Scanned {
  named: string[];
  clean: string[];
  unbuildable: string[];
}

function scanBuiltPrompts(): Scanned {
  const out: Scanned = { named: [], clean: [], unbuildable: [] };
  for (const def of bootRegistry().all()) {
    const llm = def.llm;
    if (!llm) continue;
    let prompt: string;
    try {
      prompt = llm.buildPrompt({ detected: {}, formValues: {} });
    } catch {
      out.unbuildable.push(def.metadata.id);
      continue;
    }
    // Exactly what the dispatch rule does: strip Haive's own marker blocks, then scan what is left.
    if (promptNamesAgentPath(stripAgentGuidanceBlocks(prompt), SANDBOX_WORKDIR)) {
      out.named.push(def.metadata.id);
    } else {
      out.clean.push(def.metadata.id);
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
    expect(clean.length).toBeGreaterThanOrEqual(14);
  });

  it('is not vacuous: without stripping, buildable prompts DO name agent paths', () => {
    // `named: []` above would mean nothing if stripping removed the whole prompt, or if the scan were
    // looking at empty strings. Same builders, same scan, stripping omitted: several must match,
    // because that is what `agentDefinitionGuidance` puts in a prompt. So the empty result above is
    // marker-stripping doing its job rather than the pipeline finding nothing to look at.
    const unstripped: string[] = [];
    for (const def of bootRegistry().all()) {
      if (!def.llm) continue;
      try {
        const prompt = def.llm.buildPrompt({ detected: {}, formValues: {} });
        if (promptNamesAgentPath(prompt, SANDBOX_WORKDIR)) unstripped.push(def.metadata.id);
      } catch {
        continue;
      }
    }
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
    expect(unbuildable.length).toBe(25);
  });
});
