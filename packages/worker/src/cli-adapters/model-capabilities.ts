/**
 * Model limitations LEARNED from a failed CLI invocation, and the remedies applied on
 * the next dispatch.
 *
 * Two failures are properties of the selected MODEL rather than of the prompt, the
 * credentials or the provider's health, and neither is resolvable by the user from the
 * error text (task 7780da14 died on both, on ollama/deepseek-v4-flash:cloud):
 *   "API Error: 400 this model does not support image input"
 *   "API Error: Claude's response exceeded the 32000 output token maximum. To configure
 *    this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable."
 *
 * The cycle is: classify (queues/cli-exec/failure-class.ts) -> learn (handlers.ts, via
 * learnModelLimitFromFailure) -> apply (the adapters' env, the dispatcher's prompt and
 * tool deny-list) -> re-dispatch (step-runner). This module owns the middle two.
 *
 * Everything learned is keyed by the model string it was learned FOR, so editing a
 * provider's model silently invalidates the learn instead of carrying a wrong limitation
 * onto a different model.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { capabilityClassFromMessage } from '../queues/cli-exec/failure-class.js';
import type { CliProviderName, CliProviderRecord } from './types.js';

export type ModelLimits = NonNullable<CliProviderRecord['modelLimits']>;

/** The provider fields this module reads. Structural so both a full `CliProviderRecord`
 *  (adapters, dispatcher) and a narrow column select (the learn path) satisfy it. */
export interface ProviderCapabilityView {
  name: CliProviderName;
  model: string | null;
  modelLimits: ModelLimits | null;
}

/** Adapter-declared starting ceiling for CLAUDE_CODE_MAX_OUTPUT_TOKENS, before anything is
 *  learned. Only claude-code has one: 128000 matches Opus's output limit and predates this
 *  module (see the note in claude-code.ts). zai and ollama drive the same binary against
 *  backends whose ceilings we do not know, so they start unset — the binary's own default
 *  applies until a failure teaches us better. */
const DEFAULT_OUTPUT_TOKEN_CEILING: Partial<Record<CliProviderName, number>> = {
  'claude-code': 128000,
};

/** Rungs the output-token ceiling escalates through, low to high. Same shape as the CLI
 *  timeout ladder: a failure earns the next rung up, never a repeat of what just failed. */
const OUTPUT_TOKEN_LADDER = [65536, 131072] as const;

/** The learned limits for this provider, or null when nothing was learned FOR ITS CURRENT
 *  MODEL. The model check is the whole invalidation strategy — switch a provider from a
 *  blind model to a vision one and the old `vision: false` stops applying with no clearing
 *  step to keep in sync. */
export function resolveModelLimits(provider: ProviderCapabilityView): ModelLimits | null {
  const limits = provider.modelLimits;
  if (!limits) return null;
  return limits.model === (provider.model ?? '') ? limits : null;
}

/** The output-token ceiling in effect for this provider: what we learned, else the
 *  adapter's declared default, else null (the CLI's own default applies). */
function resolveOutputTokenCeiling(provider: ProviderCapabilityView): number | null {
  return (
    resolveModelLimits(provider)?.maxOutputTokens ??
    DEFAULT_OUTPUT_TOKEN_CEILING[provider.name] ??
    null
  );
}

/** The next rung strictly ABOVE the ceiling already in effect, or null when the ladder is
 *  spent. "Strictly above" is what stops a learn from ever DOWNGRADING an adapter that
 *  already declares a high default (claude-code at 128000 skips straight to 131072). */
function nextOutputTokenRung(effective: number | null): number | null {
  for (const rung of OUTPUT_TOKEN_LADDER) {
    if (effective === null || rung > effective) return rung;
  }
  return null;
}

/** The rung below `current`, or null when `current` is the first rung (or not a rung at
 *  all). Used only by the rollback: a ceiling the provider rejected steps back to the last
 *  value that was not rejected. */
function previousOutputTokenRung(current: number | undefined): number | null {
  if (current === undefined) return null;
  const idx = OUTPUT_TOKEN_LADDER.indexOf(current as (typeof OUTPUT_TOKEN_LADDER)[number]);
  return idx > 0 ? OUTPUT_TOKEN_LADDER[idx - 1]! : null;
}

/* ------------------------------------------------------------------ */
/* Remedy 1: the output-token ceiling (claude-family env)              */
/* ------------------------------------------------------------------ */

/** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for a claude-family invocation, or `{}` when no ceiling
 *  is in effect. Spread BEFORE the provider's own envVars by every caller, so a value the
 *  user set by hand still wins over anything learned. */
export function claudeFamilyOutputTokenEnv(
  provider: ProviderCapabilityView,
): Record<string, string> {
  const ceiling = resolveOutputTokenCeiling(provider);
  return ceiling === null ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(ceiling) };
}

/* ------------------------------------------------------------------ */
/* Remedy 2 + 3: no vision (prompt boundary + tool deny)               */
/* ------------------------------------------------------------------ */

export const MODEL_CAPABILITY_BOUNDARY_MARKER = '<haive_model_capability_boundary>';

/** Prompt contract paired with the screenshot tool deny below. Same shape and role as
 *  WORKTREE_GIT_BOUNDARY_PROMPT: it explains a restriction the agent is about to hit, so
 *  the agent routes around it instead of retrying into the same 400. Text-first alternatives
 *  are named explicitly because the browser-verification steps otherwise reach for
 *  take_screenshot by default. */
const NO_VISION_BOUNDARY_PROMPT = [
  MODEL_CAPABILITY_BOUNDARY_MARKER,
  'Model capability boundary:',
  'The model running this task cannot read images. Sending it one fails the whole run.',
  'Do not take screenshots, do not open image files (.png/.jpg/.webp/.gif/.svg), and do not',
  'ask for any visual confirmation of your work.',
  'To inspect a page, use the text-based tools instead: `take_snapshot` (accessibility tree),',
  '`evaluate_script` (returns JSON), `list_console_messages`, and `list_network_requests`.',
  'They carry everything you need to verify structure, content, errors and failed requests.',
  '</haive_model_capability_boundary>',
].join('\n');

/** Prepend the boundary once, when the model is known to reject image input. The marker
 *  makes this safe on a retry path that re-adapts an already-adapted prompt. */
export function withModelCapabilityBoundary(
  prompt: string,
  provider: ProviderCapabilityView,
): string {
  if (resolveModelLimits(provider)?.vision !== false) return prompt;
  if (prompt.includes(MODEL_CAPABILITY_BOUNDARY_MARKER)) return prompt;
  return `${NO_VISION_BOUNDARY_PROMPT}\n\n${prompt}`;
}

/** Tool names to add to `--disallowedTools` for a model that cannot read images. The prompt
 *  above asks the agent not to screenshot; this makes it so. chrome-devtools is the only
 *  wired MCP that returns an image block (resolvers.ts), and denying one tool leaves the
 *  rest of the browser surface — snapshot, script, console, network — fully usable. */
export function visionDisallowedTools(provider: ProviderCapabilityView): string[] {
  return resolveModelLimits(provider)?.vision === false
    ? ['mcp__chrome-devtools__take_screenshot']
    : [];
}

/* ------------------------------------------------------------------ */
/* Learning                                                            */
/* ------------------------------------------------------------------ */

/** Compute the limits to persist for a capability failure, or null when there is nothing
 *  new to learn (the limitation is already recorded, or the ladder is spent). Pure, so the
 *  ladder and its rollback are testable without a database. */
export function nextModelLimits(
  provider: ProviderCapabilityView,
  errorMessage: string | null,
  now: Date,
): ModelLimits | null {
  const cls = capabilityClassFromMessage(errorMessage);
  if (!cls) return null;
  // Start from the CURRENT model's learns only; a learn for a different model is stale and
  // must be dropped wholesale rather than merged into.
  const current = resolveModelLimits(provider);
  const base: ModelLimits = {
    ...current,
    model: provider.model ?? '',
    learnedAt: now.toISOString(),
  };

  if (cls === 'no_image_support') {
    // Terminal: written once. A second image failure with the flag already set means
    // something other than our remedies is sending images, and re-learning it would not
    // change the next dispatch.
    return current?.vision === false ? null : { ...base, vision: false };
  }

  if (cls === 'output_cap_reached') {
    if (current?.maxOutputTokensExhausted) return null;
    const next = nextOutputTokenRung(resolveOutputTokenCeiling(provider));
    // Ladder spent: record that so later failures stop trying and fail fast.
    if (next === null) return { ...base, maxOutputTokensExhausted: true };
    return { ...base, maxOutputTokens: next };
  }

  // max_tokens_too_large — the rollback. The provider rejected a ceiling as larger than the
  // model allows, so step back to the rung below and stop raising for this model. When we
  // never set a ceiling the rejection came from the user's own envVars: mark it exhausted
  // (so we never add to their problem) but leave their value alone.
  const rolledBack = previousOutputTokenRung(current?.maxOutputTokens);
  const reverted: ModelLimits = { ...base, maxOutputTokensExhausted: true };
  if (rolledBack === null) delete reverted.maxOutputTokens;
  else reverted.maxOutputTokens = rolledBack;
  if (current?.maxOutputTokensExhausted && current.maxOutputTokens === reverted.maxOutputTokens) {
    return null;
  }
  return reverted;
}

/** Record what this failure taught us about the provider's model. Called from the cli-exec
 *  completion path, so EVERY invocation kind (cli, agent_mining, DAG coder, sub-agent)
 *  contributes a learn even though only the single-CLI step path auto-retries — a mining
 *  agent that discovers the model is blind still fixes the next dispatch for everyone.
 *
 *  Best-effort by contract: the caller wraps this, and a learn that fails must never fail
 *  the invocation it was observing. */
export async function learnModelLimitFromFailure(
  db: Database,
  providerId: string,
  errorMessage: string | null,
): Promise<ModelLimits | null> {
  if (!capabilityClassFromMessage(errorMessage)) return null;
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
    columns: { name: true, model: true, modelLimits: true },
  });
  if (!provider) return null;
  const next = nextModelLimits(provider, errorMessage, new Date());
  if (!next) return null;
  await db
    .update(schema.cliProviders)
    .set({ modelLimits: next, updatedAt: new Date() })
    .where(eq(schema.cliProviders.id, providerId));
  return next;
}
