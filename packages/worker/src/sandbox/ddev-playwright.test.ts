import { execFileSync } from 'node:child_process';
import { afterEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({ ddevExec: vi.fn() }));

vi.mock('./ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ddev-runner.js')>()),
  ddevExec: m.ddevExec,
}));

import { configService } from '@haive/shared';
import {
  ensureDdevPlaywrightBrowsers,
  failureReason,
  provisionScript,
  sweepScript,
} from './ddev-playwright.js';

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

// A run abandoned by a worker restart keeps running inside the container — killing the
// `docker exec` client does not kill what it started — and under the html reporter it ends
// by serving the report forever while its cleanup keeps mutating the app.
describe('sweepScript', () => {
  const script = sweepScript();

  it('counts before killing, and reports the count on a marker of ours', () => {
    expect(script).toContain('HAIVE_KILLED=');
    expect(script.indexOf('grep -cE')).toBeLessThan(script.indexOf('pkill'));
  });

  it('kills the report server as well as the test runner', () => {
    expect(script).toContain('pkill -f playwright');
    expect(script).toContain('pkill -f headless_shell');
  });

  it('treats a clean container as the normal path, not an error', () => {
    // grep -c exits 1 on no match; every failure-capable step is tolerated so a container
    // with nothing to kill cannot read as a sweep failure.
    expect(script).not.toContain('set -e');
    expect(script).toContain('|| true');
    expect(script).toContain('${n:-0}');
  });
});

// `ddevExec` splices its argument into a `bash -lc` in the runner, and a project root is a
// directory name the repository chose.
describe('ensureDdevPlaywrightBrowsers', () => {
  const handle = { container: 'haive-ddev-test', projectDir: '/repos/u/r' };
  const NUL = String.fromCharCode(0);
  const script = `echo ${Buffer.from(provisionScript(), 'utf8').toString('base64')} | base64 -d | bash`;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wordsOf = (sent: string): string[] =>
    execFileSync('bash', ['-c', `printf '%s\\0' ${sent}`], { encoding: 'utf8' })
      .split(NUL)
      .slice(0, -1);
  const run = async (root: string): Promise<string> => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    m.ddevExec.mockReset().mockResolvedValue({ exitCode: 0, output: '' });
    await ensureDdevPlaywrightBrowsers(handle, root);
    expect(m.ddevExec).toHaveBeenCalledTimes(1);
    return m.ddevExec.mock.calls[0]![1] as string;
  };

  // The control: the checks below have to be able to fail, or a green run proves nothing.
  it('sees the words the runner would make of an unquoted root, and they are not the root', () => {
    expect(wordsOf('exec -d /var/www/html/a b bash')).toEqual([
      'exec',
      '-d',
      '/var/www/html/a',
      'b',
      'bash',
    ]);
  });

  it.each([
    ['a space and a separator', 'sub dir;echo x'],
    ['quotes', `it's "q"`],
    ['a command substitution', '$(echo hi)'],
    ['a backtick substitution', '`echo hi`'],
    ['a variable', '${HOME}'],
  ])('hands the runner a project root with %s as one word', async (_n, root) => {
    expect(wordsOf(await run(root))).toEqual([
      'exec',
      '-d',
      `/var/www/html/${root}`,
      'bash',
      '-c',
      script,
    ]);
  });

  it('adds no directory at the workspace root', async () => {
    expect(await run('')).toBe(`exec bash -c "${script}"`);
  });
});
