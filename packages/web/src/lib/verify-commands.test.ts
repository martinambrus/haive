import { describe, expect, it } from 'vitest';
import {
  configFromSlots,
  saveVerifyCommands,
  slotsFromConfig,
  verifySlotsError,
  type VerifyCommandsApi,
} from './verify-commands';

describe('slotsFromConfig', () => {
  it('reads an absent key as Auto, null as Off and a string as Custom', () => {
    expect(slotsFromConfig({ test: null, lint: 'vendor/bin/phpcs' })).toEqual({
      test: { mode: 'off', text: '' },
      lint: { mode: 'custom', text: 'vendor/bin/phpcs' },
      typecheck: { mode: 'auto', text: '' },
    });
  });

  it('reads an empty or missing object as all Auto', () => {
    const auto = { mode: 'auto', text: '' };
    expect(slotsFromConfig({})).toEqual({ test: auto, lint: auto, typecheck: auto });
    expect(slotsFromConfig(undefined)).toEqual({ test: auto, lint: auto, typecheck: auto });
  });
});

describe('configFromSlots', () => {
  it('sends {} when every slot is Auto', () => {
    expect(configFromSlots(slotsFromConfig({}))).toEqual({});
  });

  it('sends null for Off and trimmed text for Custom, leaving Auto out', () => {
    const slots = slotsFromConfig({});
    slots.test = { mode: 'custom', text: '  vendor/bin/phpunit -c core  ' };
    slots.lint = { mode: 'off', text: 'ignored' };
    const sent = configFromSlots(slots);
    expect(sent).toEqual({ test: 'vendor/bin/phpunit -c core', lint: null });
    expect('typecheck' in sent).toBe(false);
  });

  it('drops the text of a slot switched back to Auto', () => {
    const slots = slotsFromConfig({});
    slots.typecheck = { mode: 'auto', text: 'tsc' };
    expect(configFromSlots(slots)).toEqual({});
  });
});

describe('verifySlotsError', () => {
  it('refuses a blank or over-long Custom command', () => {
    const slots = slotsFromConfig({});
    slots.lint = { mode: 'custom', text: '   ' };
    expect(verifySlotsError(slots)).toMatch(/lint command/);
    slots.lint = { mode: 'custom', text: 'x'.repeat(2001) };
    expect(verifySlotsError(slots)).toMatch(/2000/);
    slots.lint = { mode: 'custom', text: 'x'.repeat(2000) };
    expect(verifySlotsError(slots)).toBeNull();
  });
});

describe('saveVerifyCommands', () => {
  function fake(over: Partial<VerifyCommandsApi> = {}) {
    const calls: { path: string; body: unknown }[] = [];
    const client: VerifyCommandsApi = {
      patch: async (path, body) => {
        calls.push({ path, body });
      },
      get: async () => ({ verifyCommands: { test: null } }),
      ...over,
    };
    return { client, calls };
  }

  it('PATCHes the whole object and returns the stored state', async () => {
    const { client, calls } = fake();
    const slots = slotsFromConfig({});
    slots.test = { mode: 'off', text: '' };
    const res = await saveVerifyCommands(client, 'r1', slots);
    expect(calls).toEqual([
      { path: '/repositories/r1/tooling', body: { verifyCommands: { test: null } } },
    ]);
    expect(res).toEqual({ ok: true, slots: slotsFromConfig({ test: null }) });
  });

  it('sends {} for all Auto', async () => {
    const { client, calls } = fake();
    await saveVerifyCommands(client, 'r1', slotsFromConfig({}));
    expect(calls[0]?.body).toEqual({ verifyCommands: {} });
  });

  it('returns the api error message and does not re-read', async () => {
    let read = false;
    const { client } = fake({
      patch: async () => {
        throw new Error('Invalid verify commands: Too small');
      },
      get: async () => {
        read = true;
        return {};
      },
    });
    const res = await saveVerifyCommands(client, 'r1', slotsFromConfig({}));
    expect(res).toEqual({ ok: false, error: 'Invalid verify commands: Too small' });
    expect(read).toBe(false);
  });

  it('refuses a blank Custom command without calling the api', async () => {
    const { client, calls } = fake();
    const slots = slotsFromConfig({});
    slots.test = { mode: 'custom', text: '' };
    const res = await saveVerifyCommands(client, 'r1', slots);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
