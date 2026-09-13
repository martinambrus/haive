import { describe, expect, it } from 'vitest';
import {
  codexAppServerFallbackWarning,
  codexAppServerVerdict,
  currentCodexAppServerVerdict,
  isCodexAppServerSupported,
  type CodexAppServerVerdicts,
} from '../src/cli-adapters/codex-app-server-verdict.js';

const verdicts = (providerCliVersion: string | null, status: 'supported' | 'unsupported') =>
  ({
    'prov-1': {
      status,
      providerCliVersion,
      binaryVersion: '0.154.0',
      stage: status === 'supported' ? null : 'steer',
      detail: null,
      source: 'probe',
      at: '2026-09-13T00:00:00.000Z',
    },
  }) satisfies CodexAppServerVerdicts;

describe('codex app-server verdicts', () => {
  it('is current while the provider still runs the version it was probed on', () => {
    const provider = { id: 'prov-1', cliVersion: ' 0.154.0 ' };
    expect(currentCodexAppServerVerdict(verdicts('0.154.0', 'supported'), provider)).not.toBeNull();
    expect(isCodexAppServerSupported(verdicts('0.154.0', 'supported'), provider)).toBe(true);
  });

  it('goes stale when the provider moves to another version, so the new binary is probed', () => {
    const provider = { id: 'prov-1', cliVersion: '0.155.0' };
    expect(currentCodexAppServerVerdict(verdicts('0.154.0', 'supported'), provider)).toBeNull();
    expect(isCodexAppServerSupported(verdicts('0.154.0', 'supported'), provider)).toBe(false);
  });

  it('matches an unpinned provider to an unpinned verdict', () => {
    const provider = { id: 'prov-1', cliVersion: null };
    expect(isCodexAppServerSupported(verdicts(null, 'supported'), provider)).toBe(true);
    expect(
      isCodexAppServerSupported(verdicts(null, 'supported'), { id: 'prov-1', cliVersion: '' }),
    ).toBe(true);
  });

  it('never supports a provider with no verdict, an unsupported one, or no verdicts at all', () => {
    expect(
      isCodexAppServerSupported(verdicts('0.154.0', 'supported'), {
        id: 'other',
        cliVersion: '0.154.0',
      }),
    ).toBe(false);
    expect(
      isCodexAppServerSupported(verdicts('0.154.0', 'unsupported'), {
        id: 'prov-1',
        cliVersion: '0.154.0',
      }),
    ).toBe(false);
    expect(isCodexAppServerSupported(null, { id: 'prov-1', cliVersion: '0.154.0' })).toBe(false);
  });

  it('stamps the provider version it was taken for', () => {
    const verdict = codexAppServerVerdict(
      { cliVersion: '  0.154.0' },
      { status: 'supported', binaryVersion: '0.154.0', stage: null, detail: null, source: 'probe' },
    );
    expect(verdict.providerCliVersion).toBe('0.154.0');
    expect(Number.isNaN(Date.parse(verdict.at))).toBe(false);
  });
});

describe('codexAppServerFallbackWarning', () => {
  it('names the stage, the codex version and what to do when it recurs', () => {
    const text = codexAppServerFallbackWarning(
      { stage: 'turn_start', detail: 'Invalid request: missing field `type`' },
      '0.155.0',
    );
    expect(text).toContain('turn_start');
    expect(text).toContain('codex 0.155.0');
    expect(text).toContain('codex exec');
    expect(text).toContain('Admin');
  });

  it('omits the version when the app-server never reported one', () => {
    expect(codexAppServerFallbackWarning({ stage: 'spawn', detail: null }, null)).toMatch(
      /^codex app-server failed at spawn: no detail\. /,
    );
  });
});
