/** Persistent verdict banner for a CLI terminal, driven by the invocation ROW, not the stream.
 *
 *  Same rule as lib/step-banners.ts: a banner is gated on the STRUCTURAL column that proves the
 *  state, and the message is only the words inside it. Both facts here outlive the stream — the
 *  Redis stream expires 600s after exit, but `provider_fatal_class` and `model_identity` are on
 *  the row forever — so the banner must read the row, or it would vanish the moment the terminal
 *  went static.
 *
 *  Two things the terminal cannot otherwise show:
 *
 *   - A provider REFUSING the prompt (content moderation). Without this the user sees `exit 1`
 *     and reads it as a broken or logged-out CLI. It is neither: the provider declined this
 *     specific request, and a retry is refused identically. MEASURED on codex/gpt-5.6-sol
 *     running an 08d adversarial-QA seat.
 *   - A provider SILENTLY SWAPPING the served model. MEASURED: Claude Code `--model fable` on a
 *     security-testing prompt is served claude-opus-4-8 instead, exit 0, no error — visible only
 *     as model_identity.match === 'differs'.
 */

export interface InvocationStatusInput {
  /** The persisted provider-fatal verdict (cli_invocations.provider_fatal_class). Only
   *  'content_filter' surfaces a banner here — 'auth' / 'rate_limit' / 'server_error' already
   *  drive the step-level provider_unavailable banner, and repeating them per terminal would be
   *  noise. NULL for a success, a running row, or a genuine code error. */
  providerFatalClass?: string | null;
  /** Per-invocation model identity (cli_invocations.model_identity). A banner fires only on
   *  match === 'differs' AND a served model to name — 'exact'/'unknown', or a differs with no
   *  served string, say nothing. */
  modelIdentity?: {
    requested: string | null;
    served: string | null;
    match: 'exact' | 'differs' | 'unknown';
  } | null;
}

export type InvocationStatus = {
  /** amber = a provider verdict the user should notice but which is not a code defect. */
  tone: 'amber';
  /** Rendered bold in the banner. */
  headline: string;
  /** Plain follow-on sentence, or null when the headline stands alone. */
  detail: string | null;
};

/** The one place the row → banner mapping lives, so it is tested here rather than re-derived in
 *  the viewer. Returns null when the run has no verdict worth a persistent banner.
 *
 *  Refusal outranks a model swap: a refused run never produced a served model, so the two never
 *  co-occur meaningfully, and if a future provider both swapped AND refused, the refusal is the
 *  fact that explains the empty output. */
export function describeInvocationStatus(inv: InvocationStatusInput): InvocationStatus | null {
  if (inv.providerFatalClass === 'content_filter') {
    return {
      tone: 'amber',
      headline: 'The provider refused this request (content policy).',
      detail:
        'This is not a CLI failure — the provider declined this specific request, so a retry ' +
        'would be refused the same way.',
    };
  }

  const mi = inv.modelIdentity;
  if (mi && mi.match === 'differs' && mi.served) {
    // requested can legitimately be null for a CLI that names only the served model; fall back
    // to a neutral phrase rather than printing "null".
    const requested = mi.requested ?? 'the requested model';
    return {
      tone: 'amber',
      headline: `Provider served ${mi.served} for a request for ${requested}.`,
      detail:
        'The provider substituted a different model — often a content or safety gate rerouting ' +
        'the request. The run itself succeeded.',
    };
  }

  return null;
}
