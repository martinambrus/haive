import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceSignInPhase } from '@/lib/use-device-sign-in';
import { DeviceSignInDialog } from './device-sign-in-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const render = (phase: DeviceSignInPhase) =>
  renderToStaticMarkup(
    <DeviceSignInDialog
      phase={phase}
      providerName="GitHub"
      onCancel={() => {}}
      onRetry={() => {}}
    />,
  );

describe('DeviceSignInDialog', () => {
  it('renders nothing while no sign-in is in progress', () => {
    expect(render({ kind: 'idle' })).toBe('');
  });

  it('says it is asking for a code while the sign-in starts, with a way to cancel', () => {
    const html = render({ kind: 'starting', providerId: 'github' });
    expect(html).toContain('Asking GitHub for a code');
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
  });

  it('shows the code and the address to enter it at, as a link that opens in a new tab', () => {
    const html = render({
      kind: 'waiting',
      providerId: 'github',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
    });
    expect(html).toContain('WDJB-MJHT');
    expect(html).toMatch(/<a [^>]*href="https:\/\/github.com\/login\/device"[^>]*target="_blank"/);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Waiting for GitHub to confirm');
  });

  it('shows an address that is not https as text, never as a link', () => {
    const html = render({
      kind: 'waiting',
      providerId: 'github',
      userCode: 'WDJB-MJHT',
      verificationUri: 'javascript:alert(1)',
    });
    expect(html).not.toContain('<a ');
    expect(html).toContain('javascript:alert(1)');
  });

  it('shows why it failed and offers to try again or close', () => {
    const html = render({ kind: 'failed', providerId: 'github', message: 'The code expired.' });
    expect(html).toContain('The code expired.');
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<button[^>]*>Close<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Cancel<\/button>/);
  });
});
