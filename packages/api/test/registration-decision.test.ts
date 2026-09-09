import { describe, expect, it } from 'vitest';
import { decideRegistration, type RegistrationContext } from '../src/lib/registration.js';

function ctx(over: Partial<RegistrationContext> = {}): RegistrationContext {
  return {
    userCount: 5,
    mode: 'closed',
    setupTokenConfigured: false,
    setupTokenMatches: false,
    ...over,
  };
}

describe('first run', () => {
  // The whole point of the feature: an install with nobody in it must be able to make somebody,
  // and that somebody must be an admin or there is still no way into /admin.
  it('makes the first account an admin', () => {
    expect(decideRegistration(ctx({ userCount: 0 }))).toEqual({
      allow: true,
      role: 'admin',
      firstRun: true,
    });
  });

  // The mode defaults to `closed`, so a first run that honoured it would refuse the only
  // registration that can ever create the admin who would open it.
  it('is exempt from every registration mode', () => {
    for (const mode of ['open', 'invite', 'closed'] as const) {
      const d = decideRegistration(ctx({ userCount: 0, mode }));
      expect(d, `mode ${mode}`).toMatchObject({ allow: true, role: 'admin' });
    }
  });

  it('is over as soon as one user exists', () => {
    const d = decideRegistration(ctx({ userCount: 1, mode: 'open' }));
    expect(d).toEqual({ allow: true, role: 'user', firstRun: false });
  });
});

describe('SETUP_TOKEN, when configured', () => {
  it('refuses a first registration that does not present it', () => {
    const d = decideRegistration(ctx({ userCount: 0, setupTokenConfigured: true }));
    expect(d).toMatchObject({ allow: false, refusal: 'setup-token-invalid' });
  });

  it('admits one that does', () => {
    const d = decideRegistration(
      ctx({ userCount: 0, setupTokenConfigured: true, setupTokenMatches: true }),
    );
    expect(d).toMatchObject({ allow: true, role: 'admin' });
  });

  // It guards the FIRST registration only. Once an admin exists the race it closes is over, and
  // the registration mode is what governs everyone else.
  it('does not apply once a user exists', () => {
    const d = decideRegistration(
      ctx({ userCount: 3, mode: 'open', setupTokenConfigured: true, setupTokenMatches: false }),
    );
    expect(d).toMatchObject({ allow: true, role: 'user' });
  });

  // Unset is the default posture: local-first, no token, register and you are the admin.
  it('is inert when unconfigured', () => {
    expect(decideRegistration(ctx({ userCount: 0 }))).toMatchObject({ allow: true, role: 'admin' });
  });
});

describe('registration mode, once an admin exists', () => {
  it('open admits a plain user', () => {
    expect(decideRegistration(ctx({ mode: 'open' }))).toEqual({
      allow: true,
      role: 'user',
      firstRun: false,
    });
  });

  it('closed refuses, and says who to ask', () => {
    const d = decideRegistration(ctx({ mode: 'closed' }));
    expect(d).toMatchObject({ allow: false, refusal: 'registration-closed' });
    expect(d.allow === false && d.message).toMatch(/administrator/i);
  });

  it('invite refuses a request carrying no invite', () => {
    const d = decideRegistration(ctx({ mode: 'invite' }));
    expect(d).toMatchObject({ allow: false, refusal: 'invite-required' });
  });

  // A gate whose other outcome is CREATING AN ACCOUNT has one safe direction. A mode this function
  // does not recognise must refuse, not fall through to open.
  it('fails shut on an unrecognised mode', () => {
    const d = decideRegistration(ctx({ mode: 'something-else' as never }));
    expect(d).toMatchObject({ allow: false, refusal: 'registration-closed' });
  });

  it('never returns admin outside the first run', () => {
    for (const mode of ['open', 'invite', 'closed'] as const) {
      for (const userCount of [1, 2, 50]) {
        const d = decideRegistration(ctx({ mode, userCount }));
        expect(d.allow === true && d.role, `${mode}/${userCount}`).not.toBe('admin');
      }
    }
  });
});
