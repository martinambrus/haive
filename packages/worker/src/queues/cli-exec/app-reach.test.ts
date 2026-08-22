import { describe, expect, it } from 'vitest';
import {
  appReachPrompt,
  probeIndicatesReachable,
  withAppReach,
  type AppReach,
} from './app-reach.js';

const reach = (over: Partial<AppReach>): AppReach => ({
  mode: 'none',
  url: null,
  addHosts: [],
  mounts: [],
  env: {},
  noProxyHosts: [],
  ...over,
});

/** appReachPrompt only ever sees a reach with an app behind it, so its argument is the
 *  narrowed shape. */
const reachable = (over: Partial<AppReach>) =>
  reach({ url: 'https://x.ddev.site', mode: 'sandbox_http', ...over }) as Parameters<
    typeof appReachPrompt
  >[0];

describe('probeIndicatesReachable', () => {
  it('accepts any status the server actually returned', () => {
    // A 500 or a 403 still proves the request arrived, which is the whole question. Gating
    // on 2xx would report a locked-down or broken app as unreachable and send the agents
    // back to reading source.
    for (const code of ['200', '403', '404', '500']) {
      expect(probeIndicatesReachable(0, code)).toBe(true);
    }
  });

  it('rejects curl 000, which means it never connected', () => {
    expect(probeIndicatesReachable(0, '000')).toBe(false);
  });

  it('rejects a failed probe regardless of what it printed', () => {
    expect(probeIndicatesReachable(7, 'curl: (7) Failed to connect')).toBe(false);
    expect(probeIndicatesReachable(0, '')).toBe(false);
  });

  it('reads the status off the tail, past whatever the shell wrote first', () => {
    expect(probeIndicatesReachable(0, 'Warning: something\n200')).toBe(true);
  });
});

describe('appReachPrompt', () => {
  it('names curl when the sandbox can reach the app directly', () => {
    const p = appReachPrompt(reachable({ mode: 'sandbox_http' }));
    expect(p).toContain('https://x.ddev.site');
    expect(p).toContain('curl');
  });

  it('names the browser as the HTTP client when nothing else can reach the app', () => {
    // The failure this exists for: agents told only the URL reached for curl, failed, and
    // fell back to their provider's own web tool.
    const p = appReachPrompt(reachable({ mode: 'browser_only' }));
    expect(p).toContain('evaluate_script');
    expect(p).toContain('fetch()');
    // Forbidden fetch headers are named so those attacks are reported as out of scope
    // rather than as tested and clean.
    expect(p).toContain('Host');
  });

  it('rules out provider built-in web tools whichever way the app is reached', () => {
    // They run on the provider's host: they cannot reach a private hostname by construction,
    // and asking them leaks the task's URLs to a third party.
    for (const mode of ['sandbox_http', 'browser_only'] as const) {
      expect(appReachPrompt(reachable({ mode }))).toContain('web_reader');
    }
  });
});

describe('withAppReach', () => {
  it('prepends the block once, however many times it is applied', () => {
    const once = withAppReach('BODY', reach({ mode: 'sandbox_http', url: 'https://x.ddev.site' }));
    const twice = withAppReach(once, reach({ mode: 'browser_only', url: 'https://other' }));
    expect(twice).toBe(once);
    expect(once.split('<haive_app_reach>')).toHaveLength(2);
    expect(once).toContain('BODY');
  });

  it('says nothing at all when there is no resolved reach', () => {
    expect(withAppReach('BODY', null)).toBe('BODY');
  });

  it('says nothing when the task has no running app', () => {
    // A code-only task must not carry a paragraph about an app that was never on the table;
    // the MCP surface block already tells it not to plan verification it cannot run.
    expect(withAppReach('BODY', reach({ mode: 'none' }))).toBe('BODY');
  });
});
