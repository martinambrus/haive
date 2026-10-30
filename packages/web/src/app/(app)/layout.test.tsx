import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import AppLayout from './layout';
import { AdminGuard } from '@/components/admin-guard';
import { ForcedPasswordGuard } from '@/components/forced-password-guard';
import { GlobalPauseBanner } from '@/components/global-pause-banner';
import { MaintenanceNotice } from '@/components/maintenance-notice';
import { NotificationProvider } from '@/components/notifications/notification-provider';
import { SidebarNav } from '@/components/sidebar-nav';

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'haive_access', value: 'token' }] }),
}));
// Only imported here: its terminal library reads `self` as it loads, and nothing renders in this file.
vi.mock('@/components/cli-auth-banner-modal', () => ({ CliAuthBannerModal: () => null }));

let mustChangePassword: boolean | undefined;

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => JSON.parse(JSON.stringify(body)),
});

async function fakeFetch(input: unknown) {
  const path = new URL(String(input)).pathname;
  if (path === '/auth/me') {
    return reply(200, {
      user: {
        id: 'u1',
        email: 'user@example.com',
        role: 'user',
        status: 'active',
        mustChangePassword,
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    });
  }
  // The api answers every other request of a flagged session with this refusal.
  if (mustChangePassword) {
    return reply(403, { error: 'Choose a new password to continue', code: 'must_change_password' });
  }
  if (path === '/user-settings/ui-prefs') return reply(200, { settingsJson: '{}' });
  if (path === '/modules') return reply(200, { modules: [] });
  return reply(404, { error: `not stubbed: ${path}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());

interface Props {
  children?: ReactNode;
  mustChangePassword?: boolean;
  watch?: boolean;
}
type El = ReactElement<Props>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<Props>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

/** Where React keeps `target`: the type, key and slot of every level from the root down to it. */
function slotOf(node: ReactNode, target: unknown, at = ''): string | undefined {
  if (Array.isArray(node)) {
    for (const [index, kid] of node.entries()) {
      const found = slotOf(kid, target, `${at}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Props>(node)) return undefined;
  const name = typeof node.type === 'string' ? node.type : node.type.name;
  const here = `${at}/${name}${node.key === null ? '' : `#${node.key}`}`;
  return node.type === target ? here : slotOf(node.props.children, target, here);
}

async function render(flag: boolean | undefined) {
  mustChangePassword = flag;
  return AppLayout({ children: null });
}

const all = (els: El[], type: unknown) => els.filter((el) => el.type === type);

/** The authenticated shell's elements. The recovery shell has no sidebar, so without this check an
 *  absence asserted below could mean the shell never rendered. */
async function shellOf(flag: boolean | undefined) {
  const els = flatten(await render(flag));
  expect(all(els, SidebarNav)).toHaveLength(1);
  return els;
}

describe('the app shell while the password must change', () => {
  it('mounts no notification provider', async () => {
    expect(all(await shellOf(true), NotificationProvider)).toHaveLength(0);
  });

  it('mounts no global pause banner', async () => {
    expect(all(await shellOf(true), GlobalPauseBanner)).toHaveLength(0);
  });

  it('tells the sidebar and the maintenance notice to stand down, and keeps the password guard', async () => {
    const els = await shellOf(true);
    expect(all(els, SidebarNav)[0]?.props.mustChangePassword).toBe(true);
    expect(all(els, MaintenanceNotice)[0]?.props.watch).toBe(false);
    expect(all(els, ForcedPasswordGuard)[0]?.props.mustChangePassword).toBe(true);
  });
});

describe.each([false, undefined])('the app shell when the flag is %s', (flag) => {
  it('mounts the notification provider and the global pause banner', async () => {
    const els = await shellOf(flag);
    expect(all(els, NotificationProvider)).toHaveLength(1);
    expect(all(els, GlobalPauseBanner)).toHaveLength(1);
  });

  it('lets the sidebar and the maintenance notice poll, and keeps the password guard', async () => {
    const els = await shellOf(flag);
    expect(all(els, SidebarNav)[0]?.props.mustChangePassword ?? false).toBe(false);
    expect(all(els, MaintenanceNotice)[0]?.props.watch ?? true).toBe(true);
    expect(all(els, ForcedPasswordGuard)[0]?.props.mustChangePassword).toBe(false);
  });
});

describe('the page in the app shell', () => {
  // A different place in the tree remounts the page when the flag flips after the password change,
  // which drops the account page's "Password changed." message.
  it('sits in the same place in the tree whatever the flag says', async () => {
    const flagged = slotOf(await render(true), AdminGuard);
    expect(flagged).toMatch(/MaintenanceNotice.*ForcedPasswordGuard.*AdminGuard$/);
    expect(slotOf(await render(false), AdminGuard)).toBe(flagged);
  });
});
