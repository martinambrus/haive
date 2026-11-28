import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { buttons, createRenderer, fire, isDisabled } from '../../test/render-tree';
import { CliProviderTest } from './cli-provider-test';
import { IMAGE_BUILDING_REASON } from '@/lib/cli-image-build';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('@/lib/use-cli-login', () => ({ useCliLogin: () => ({ requireCliLogin() {} }) }));
const h = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('@/lib/cli-jobs', async (original) => ({
  ...(await original<typeof import('@/lib/cli-jobs')>()),
  runCliProbe: h.probe,
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const card = (loginBlockMessage?: string | null) =>
  createRenderer(() =>
    createElement(CliProviderTest, {
      providerId: 'p',
      providerName: 'codex',
      providerLabel: 'Codex',
      rowAuthMode: 'subscription',
      rowAuthStatus: 'auth_expired',
      loginBlockMessage,
    }),
  );

it('T1 disables Log in with the reason while the image is not usable, and leaves Test alone', () => {
  const view = card(IMAGE_BUILDING_REASON);
  const login = buttons(view.tree(), /^log in$/i)[0]!;
  expect(isDisabled(login)).toBe(true);
  expect(login.props.title).toBe(IMAGE_BUILDING_REASON);
  expect(isDisabled(buttons(view.tree(), /^test connection$/i)[0]!)).toBe(false);
});

it('T1 keeps Log in enabled without a block message', () => {
  const view = card(null);
  const login = buttons(view.tree(), /^log in$/i)[0]!;
  expect(isDisabled(login)).toBe(false);
  expect(login.props.title).toBeUndefined();
});

it('T1 gates the Log in inside a test result as well', async () => {
  h.probe.mockResolvedValue({
    ok: false,
    targetMode: 'cli',
    cli: { ok: false, authStatus: 'auth_expired', error: 'login' },
  });
  const view = card(IMAGE_BUILDING_REASON);
  fire.click(buttons(view.tree(), /^test connection$/i)[0]!);
  await vi.advanceTimersByTimeAsync(0);
  view.draw();
  const logins = buttons(view.tree(), /^log in$/i);
  expect(logins).toHaveLength(2);
  expect(logins.every(isDisabled)).toBe(true);
});
