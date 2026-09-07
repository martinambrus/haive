import { describe, it, expect } from 'vitest';
import { failureReason, provisionScript } from './ddev-playwright.js';

describe('provisionScript', () => {
  const script = provisionScript();

  // The measured trap: on Debian trixie `playwright install-deps` falls back to its
  // ubuntu20.04 package set, asks apt for ttf-ubuntu-font-family, and one unavailable name
  // aborts the whole transaction — so it exits 0 having installed nothing.
  it('never runs install-deps for real, only to read the list', () => {
    expect(script).toContain('install-deps --dry-run');
    expect(script).not.toMatch(/install-deps(?! --dry-run)/);
  });

  // apt-get install -s resolves libasound2 / libatk1.0-0 / libfontconfig through their
  // t64 providers, where apt-cache policy reports Candidate: (none) and would drop three
  // libraries chromium actually needs.
  it('filters packages with the resolver, not with a name lookup', () => {
    expect(script).toContain('apt-get install -s -y --no-install-recommends');
    expect(script).not.toContain('apt-cache');
  });

  it('fails loud rather than marking the container done on an empty list', () => {
    expect(script).toContain('|| exit 3');
    expect(script).toContain('|| exit 4');
  });

  it('guards the apt half with a marker whose lifetime matches the container', () => {
    expect(script).toContain('[ ! -f /tmp/haive-playwright-deps ]');
    expect(script).toContain('touch /tmp/haive-playwright-deps');
  });

  it('puts the browsers on the volume that survives a ddev restart', () => {
    expect(script).toContain('ln -s /mnt/ddev-global-cache/ms-playwright');
    expect(script).toContain('if [ ! -e "$HOME/.cache/ms-playwright" ]; then');
  });

  it('installs only chromium, the browser this project actually configures', () => {
    expect(script).toContain('npx playwright install chromium');
  });
});

describe('failureReason', () => {
  it('names each way the script gives up', () => {
    expect(failureReason(3)).toContain("Playwright's own dependency list");
    expect(failureReason(4)).toContain('resolved by apt');
    expect(failureReason(1)).toContain('exited 1');
  });
});
