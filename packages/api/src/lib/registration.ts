import type { RegistrationMode } from '@haive/shared';

/**
 * May this registration proceed, and as what?
 *
 * Extracted from the route because the decision is the whole feature and `packages/api` has no
 * HTTP-level auth tests — the house style is a pure function in `src/lib/` with a vitest file
 * (`resolveOnboardingVerdict` is the precedent), with anything needing a real database in the
 * `*-smoke.ts` tier. The route stays a thin caller that supplies the counts and applies the answer.
 *
 * The caller MUST read `userCount` inside the same transaction that performs the insert, under the
 * bootstrap advisory lock. This function cannot enforce that and is where the race would otherwise
 * hide: two requests that both see zero users would both be told `admin`.
 */

export interface RegistrationContext {
  /** Users already in the database, read inside the insert's transaction. */
  userCount: number;
  mode: RegistrationMode;
  /**
   * `SETUP_TOKEN` is configured on this install, so the FIRST registration must present it.
   *
   * Opt-in rather than default: Haive is local-first and the installer opens `localhost` before
   * anything is exposed, so first-user-becomes-admin is the honest default UX. An instance exposed
   * to a network before its owner registers has a real race — whoever registers first owns it —
   * and this is the switch that closes it.
   */
  setupTokenConfigured: boolean;
  /** The token the request presented, if any. Compared by the caller, never stored. */
  setupTokenMatches: boolean;
  /**
   * The request carried an invitation the caller has already validated against the database.
   *
   * A boolean rather than the invite itself: whether registration is ALLOWED is this function's
   * question, while which role the invite carries is the caller's to apply — it has the row.
   */
  hasValidInvite?: boolean;
}

export type RegistrationRefusal =
  'setup-token-required' | 'setup-token-invalid' | 'registration-closed' | 'invite-required';

export type RegistrationDecision =
  | { allow: true; role: 'admin' | 'user'; firstRun: boolean }
  | { allow: false; refusal: RegistrationRefusal; message: string };

export function decideRegistration(ctx: RegistrationContext): RegistrationDecision {
  // FIRST RUN. This branch is deliberately exempt from the registration mode: the mode defaults to
  // `closed`, and an install whose own first registration were closed would have no way in at all —
  // the exact trap this feature exists to remove.
  if (ctx.userCount === 0) {
    if (ctx.setupTokenConfigured) {
      if (!ctx.setupTokenMatches) {
        return {
          allow: false,
          refusal: 'setup-token-invalid',
          message:
            'This install requires a setup token for the first account. Check SETUP_TOKEN in the ' +
            'install directory .env, or the API log line printed at first boot.',
        };
      }
    }
    return { allow: true, role: 'admin', firstRun: true };
  }

  if (ctx.mode === 'open') return { allow: true, role: 'user', firstRun: false };

  if (ctx.mode === 'invite') {
    // The invite is validated by the caller against the database, which also applies the role it
    // carries; all this needs to know is whether one accompanied the request.
    if (ctx.hasValidInvite) return { allow: true, role: 'user', firstRun: false };
    return {
      allow: false,
      refusal: 'invite-required',
      message: 'Registration is by invitation. Ask an administrator for an invite link.',
    };
  }

  // An invite admits its holder even while registration is CLOSED. That is what makes `closed` a
  // usable default rather than a wall: the administrator hands out the only way in, one link at a
  // time, instead of opening the door to everyone to let one person through.
  if (ctx.hasValidInvite) return { allow: true, role: 'user', firstRun: false };

  // `closed`, and anything a future mode adds until it is handled above — failing SHUT is the only
  // safe direction for a gate whose other outcome is creating an account.
  return {
    allow: false,
    refusal: 'registration-closed',
    message: 'Registration is closed on this instance. Ask an administrator for an account.',
  };
}
