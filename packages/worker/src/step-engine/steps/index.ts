import { CLI_DISPATCH_STEP_IDS, PROVIDER_SENSITIVE_STEP_IDS } from '@haive/shared';
import type { StepRegistry } from '../registry.js';
import { PATH_STEP_SETS, PATH_REQUIRED_TARGETS } from '../../orchestrator/execution-paths.js';
import { registerEnvReplicateSteps } from './env-replicate/index.js';
import { registerOnboardingSteps } from './onboarding/index.js';
import { registerOnboardingUpgradeSteps } from './onboarding-upgrade/index.js';
import { registerWorkflowSteps } from './workflow/index.js';
import { registerKbAuthorSteps } from './kb-author/index.js';
import { registerRunAppSteps } from './run-app/index.js';

export {
  registerOnboardingSteps,
  registerEnvReplicateSteps,
  registerWorkflowSteps,
  registerOnboardingUpgradeSteps,
  registerKbAuthorSteps,
  registerRunAppSteps,
};

export function registerAllSteps(registry: StepRegistry): void {
  registerOnboardingSteps(registry);
  registerEnvReplicateSteps(registry);
  registerWorkflowSteps(registry);
  registerOnboardingUpgradeSteps(registry);
  registerKbAuthorSteps(registry);
  registerRunAppSteps(registry);
  assertProviderSensitiveListInSync(registry);
  assertCliDispatchListInSync(registry);
  assertPathStepSetsClosed(registry);
}

/** Startup sanity check for execution-path filtering (execution-paths.ts). Every
 *  step id referenced by a non-full PATH_STEP_SET must be a registered step, and
 *  any retained step that emits a loop_back / revise / restart must keep its
 *  target in the SAME set (PATH_REQUIRED_TARGETS) — otherwise buildRunList would
 *  trim a step the fix loop / forward walk jumps to. A retained loop step with no
 *  PATH_REQUIRED_TARGETS entry is also rejected, so adding a new loop hook without
 *  declaring its target fails the boot instead of silently breaking filtering. */
function assertPathStepSetsClosed(registry: StepRegistry): void {
  for (const [path, set] of Object.entries(PATH_STEP_SETS)) {
    for (const id of set) {
      const def = registry.get(id);
      if (!def) {
        throw new Error(`execution path '${path}' references unregistered step '${id}'`);
      }
      const hasLoop = Boolean(
        def.fixLoop || def.reviseLoop || def.restartLoop || def.fixLoopOnError,
      );
      if (!hasLoop) continue;
      const target = PATH_REQUIRED_TARGETS[id];
      if (!target) {
        throw new Error(
          `step '${id}' has a loop/revise/restart hook but no PATH_REQUIRED_TARGETS entry — ` +
            'declare its loop target so execution-path filtering stays closed',
        );
      }
      if (!set.has(target)) {
        throw new Error(
          `execution path '${path}' retains '${id}' but drops its loop target '${target}'`,
        );
      }
    }
  }
}

/** Startup sanity check: the PROVIDER_SENSITIVE_STEP_IDS constant in
 *  @haive/shared is read by the api package to know which task_steps rows
 *  to invalidate on provider change. It must match the set of step
 *  definitions with `metadata.providerSensitive === true`. Drift would
 *  silently cause stale detect output or over-invalidation. */
function assertProviderSensitiveListInSync(registry: StepRegistry): void {
  const actual = new Set(
    registry
      .all()
      .filter((d) => d.metadata.providerSensitive === true)
      .map((d) => d.metadata.id),
  );
  const declared = new Set(PROVIDER_SENSITIVE_STEP_IDS);
  const missing = [...actual].filter((id) => !declared.has(id));
  const extra = [...declared].filter((id) => !actual.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `PROVIDER_SENSITIVE_STEP_IDS out of sync with StepDefinition.metadata.providerSensitive — missing in shared: [${missing.join(', ')}], extra in shared: [${extra.join(', ')}]`,
    );
  }
}

/** Startup sanity check: CLI_DISPATCH_STEP_IDS in @haive/shared drives whether
 *  the web renders the per-step CLI picker (the api/web packages cannot import
 *  this registry). It must match the set of step definitions that actually
 *  dispatch a CLI — those defining `llm`, `agentMining`, or `dagExecute` (the
 *  same predicate the step runner uses). Drift would surface the picker on a
 *  deterministic step or hide it on one that runs a CLI. */
function assertCliDispatchListInSync(registry: StepRegistry): void {
  const actual = new Set(
    registry
      .all()
      .filter((d) => Boolean(d.llm || d.agentMining || d.dagExecute))
      .map((d) => d.metadata.id),
  );
  const declared = new Set(CLI_DISPATCH_STEP_IDS);
  const missing = [...actual].filter((id) => !declared.has(id));
  const extra = [...declared].filter((id) => !actual.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `CLI_DISPATCH_STEP_IDS out of sync with StepDefinition CLI dispatch (llm|agentMining|dagExecute) — missing in shared: [${missing.join(', ')}], extra in shared: [${extra.join(', ')}]`,
    );
  }
}
