import type { ModelIdentity } from '@haive/shared';
import type { CliCommandSpec } from '../../cli-adapters/types.js';

/* ------------------------------------------------------------------ */
/* Which model actually answered                                       */
/* ------------------------------------------------------------------ */
/* Haive knows which model it ASKS for. It did not know which one replied, so a
 * silent upstream swap was invisible. MEASURED 2026-08-18: a provider configured
 * for `glm-5.2[1m]` was served `glm-5.3` by api.z.ai, with no config change here.
 *
 * The evidence is already on the wire — the same output the token-usage pass
 * parses — so nothing extra is spawned, prompted or billed to collect it.
 *
 * Coverage is MEASURED per provider, not assumed. Re-measure with
 * packages/worker/test/model-report-discover.ts rather than editing these notes
 * from vendor docs:
 *   claude-code, zai, ollama, muse, grok, openrouter  stream-json, both channels
 *   gemini                                            stats.models keys
 *   antigravity                                       its --log-file, a LABEL
 *   codex, amp                                        NOTHING (see below)
 *
 * codex's `exec --json` carries no model on any typed event — verified against a
 * complete 3.4 MB successful run, not just a failed one. amp's init event reports
 * `agent_mode` ("medium") instead, because Amp deliberately abstracts the model
 * away. For both, `served` stays null and `match` is 'unknown' forever; that is a
 * true statement about our evidence, and it is why 'unknown' can never fail a run. */

/** Model values that are protocol placeholders rather than model ids.
 *
 *  Claude Code emits an `assistant` event with `model: "<synthetic>"` and zero
 *  token usage when IT — not the endpoint — generates the message, e.g. to report
 *  an API error (MEASURED on an OpenRouter 402 and on claude-code error paths).
 *  Taking that as `served` would report a model named "<synthetic>" for every
 *  failed run.
 *
 *  Keyed on the angle-bracket CONVENTION rather than the literal "<synthetic>":
 *  a model id is never bracketed, so anything bracketed is a sentinel. If the
 *  binary adds `<unknown>` tomorrow this still excludes it, whereas matching the
 *  exact word would silently start reporting it as a real model. */
const PLACEHOLDER_MODEL_RE = /^<.*>$/;

export function isPlaceholderModel(value: string): boolean {
  return PLACEHOLDER_MODEL_RE.test(value.trim());
}

/** VOLATILE — antigravity log wording, isolated here on purpose.
 *
 *  agy has no structured output at all (plain `-p`, no --output-format), so its
 *  own `--log-file` is the ONLY channel that names a model. The line is a Go log
 *  statement:
 *
 *    model_config_manager.go:311] Propagating selected model override to backend: label="Gemini 3.7 Flash (High)"
 *
 *  That is ephemeral by the forward-compatibility rule — upstream can reword it in
 *  any release. It is matched anyway because the alternative is no model at all
 *  for this provider, and there is precedent: classifyAntigravityDiagnostic already
 *  reads this same log for fatal-error classification.
 *
 *  Contained accordingly: ONE constant, matched loosely (the file/line prefix and
 *  the sentence's leading words are NOT part of the pattern), and a miss returns
 *  null so the caller records "no served model" — the same honest outcome as codex.
 *  It never throws and never fails a run. Note the captured value is a human LABEL
 *  ("Gemini 3.7 Flash (High)"), not a model id, so it will not string-equal a
 *  configured model and `match` stays 'unknown' unless a label was configured. */
const AGY_MODEL_LABEL_RE = /selected model override to backend:\s*label="([^"]+)"/i;

export function parseAntigravityModelLabel(log: string | null | undefined): string | null {
  if (!log) return null;
  const m = AGY_MODEL_LABEL_RE.exec(log);
  const label = m?.[1]?.trim();
  return label ? label : null;
}

/** The model this invocation ASKED for, read off the command actually executed.
 *
 *  Taken from the spec rather than the provider row because the spec is what ran:
 *  the adapter has already merged provider config, per-step overrides and its own
 *  defaults into it. Only needed for CLIs whose output names no model (codex via
 *  `--model`); the claude-family report it themselves in the init event.
 *
 *  Deliberately does NOT fall back to the ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL
 *  triple. zai sets all three to different values (glm-5.2[1m] for opus/sonnet,
 *  glm-4.7 for haiku) and which one applies depends on the tier the binary picks at
 *  runtime, so guessing one would record a model that may never have been asked for.
 *  Every provider that sets those also reports init.model, which is the real answer. */
export function requestedFromSpec(spec: Pick<CliCommandSpec, 'args' | 'env'>): string | null {
  const args = spec.args ?? [];
  const idx = args.lastIndexOf('--model');
  if (idx !== -1) {
    const value = args[idx + 1];
    if (typeof value === 'string' && value.trim() && !value.startsWith('-')) return value.trim();
  }
  const env = spec.env ?? {};
  const explicit = env.ANTHROPIC_MODEL;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return null;
}

/** A trailing bracketed variant tag: the `[1m]` in `glm-5.3[1m]`.
 *
 *  Z.AI names a context-window variant this way and then echoes the model back
 *  WITHOUT the tag, so every zai run reported a mismatch it could do nothing about.
 *  Anchored to the end and forbidding nested brackets, so it can only ever match a
 *  trailing `[...]` segment and never eat part of a model id. Nothing else in the
 *  measured set uses brackets — claude-code, grok, muse and openrouter have none,
 *  and ollama's variant marker is a colon (`glm-5.2:cloud`), untouched by this. */
const TRAILING_VARIANT_TAG_RE = /\[[^[\]]*\]$/;

function stripTrailingVariantTag(value: string): string {
  return value.replace(TRAILING_VARIANT_TAG_RE, '');
}

/** Compare what we asked for against what answered.
 *
 *  Beyond exact equality there is ONE forgiven difference, deliberately the
 *  narrowest one that fixes the zai false positive: the endpoint dropped a trailing
 *  variant tag while naming the same model. Note what this does NOT do — it does not
 *  case-fold, does not strip any other suffix, and crucially does not compare
 *  tag-stripped strings in general. It forgives only the PRESENCE of a tag on one
 *  side. Two DIFFERENT tags (`glm-5.3[1m]` vs `glm-5.3[200k]`) stay 'differs',
 *  because being handed a different context variant is a real difference, not a
 *  cosmetic one.
 *
 *  The reason for that care: `glm-5.3[1m]` -> `glm-5.3` is a tag being dropped, but
 *  `glm-5.2[1m]` -> `glm-5.3` is a version swap, and a normalizer that merely
 *  stripped tags from both sides before comparing would still catch the second only
 *  by luck. Keying on tag PRESENCE rather than tag-stripped equality keeps the two
 *  cases structurally distinct.
 *
 *  `match` is a verdict about whether the same MODEL answered, not about byte
 *  equality; `requested` and `served` are always stored verbatim, so a forgiven
 *  difference is still visible to anyone reading the record.
 *
 *  'unknown' whenever either side is missing. That is the permanent state for codex
 *  and amp, and it is what keeps strict mode from failing providers we simply have
 *  no evidence about. */
export function classifyModelMatch(
  requested: string | null,
  served: string | null,
): ModelIdentity['match'] {
  if (!requested || !served) return 'unknown';
  if (requested === served) return 'exact';
  const requestedTagged = TRAILING_VARIANT_TAG_RE.test(requested);
  const servedTagged = TRAILING_VARIANT_TAG_RE.test(served);
  if (
    requestedTagged !== servedTagged &&
    stripTrailingVariantTag(requested) === stripTrailingVariantTag(served)
  ) {
    return 'exact';
  }
  return 'differs';
}

/** What a CLI's own output said about the models it used. */
export interface StreamModelReport {
  requested: string | null;
  served: string | null;
  billed: string[];
}

export interface ModelIdentityInput {
  /** claude-family stream-json report (createStreamJsonCollector.getModelIdentity). */
  stream?: StreamModelReport | null;
  /** gemini `stats.models` keys, in document order. */
  geminiModels?: string[] | null;
  /** antigravity's captured --log-file. */
  antigravityLog?: string | null;
  /** Fallback for CLIs that name no model in their output. */
  specRequested?: string | null;
}

/** Merge every available channel into one record, or null when no channel said
 *  anything at all (nothing to store, and a row of nulls would imply we looked and
 *  found nothing rather than that this path reports nothing). */
export function buildModelIdentity(input: ModelIdentityInput): ModelIdentity | null {
  const requested = input.stream?.requested ?? input.specRequested ?? null;

  let served: string | null = null;
  let source: ModelIdentity['source'] = null;
  let billed: string[] = [];

  if (input.stream) {
    billed = input.stream.billed;
    if (input.stream.served) {
      served = input.stream.served;
      source = 'stream-json';
    }
  }

  if (!served && input.geminiModels && input.geminiModels.length > 0) {
    // gemini reports a MAP of models it used; a normal run has one key, and a run
    // that fell back to flash has two. The first key is taken as the answering
    // model and every key is recorded in `billed`, so the fallback is visible
    // rather than silently collapsed.
    served = input.geminiModels[0] ?? null;
    source = served ? 'gemini-stats' : null;
    if (billed.length === 0) billed = [...input.geminiModels];
  }

  if (!served) {
    const label = parseAntigravityModelLabel(input.antigravityLog);
    if (label) {
      served = label;
      source = 'antigravity-log';
    }
  }

  if (!served && requested) source = 'provider-config';
  if (!requested && !served && billed.length === 0) return null;

  return { requested, served, billed, source, match: classifyModelMatch(requested, served) };
}
