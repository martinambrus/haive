import { describe, expect, it } from 'vitest';
import { describeInvocationStatus } from './cli-stream-status';

describe('describeInvocationStatus', () => {
  // MEASURED: codex/gpt-5.6-sol refusing an 08d seat. The user must see this is a refusal, not
  // a broken CLI.
  it('surfaces a content_filter refusal', () => {
    const s = describeInvocationStatus({ providerFatalClass: 'content_filter' });
    expect(s?.tone).toBe('amber');
    expect(s?.headline).toMatch(/refused this request/i);
    expect(s?.detail).toMatch(/not a CLI failure/i);
  });

  // The other fatal classes drive the step-level provider_unavailable banner already; repeating
  // them per terminal would be noise.
  it('says nothing for auth / rate_limit / server_error', () => {
    expect(describeInvocationStatus({ providerFatalClass: 'auth' })).toBeNull();
    expect(describeInvocationStatus({ providerFatalClass: 'rate_limit' })).toBeNull();
    expect(describeInvocationStatus({ providerFatalClass: 'server_error' })).toBeNull();
  });

  // MEASURED: Claude Code --model fable served claude-opus-4-8 on a security prompt.
  it('surfaces a model swap on match:differs with a served model', () => {
    const s = describeInvocationStatus({
      modelIdentity: { requested: 'claude-fable-5', served: 'claude-opus-4-8', match: 'differs' },
    });
    expect(s?.tone).toBe('amber');
    expect(s?.headline).toContain('claude-opus-4-8');
    expect(s?.headline).toContain('claude-fable-5');
  });

  it('names the requested model neutrally when the CLI reported only the served one', () => {
    const s = describeInvocationStatus({
      modelIdentity: { requested: null, served: 'claude-opus-4-8', match: 'differs' },
    });
    expect(s?.headline).toContain('claude-opus-4-8');
    expect(s?.headline).not.toContain('null');
  });

  it('says nothing for an exact match or an unknown identity', () => {
    expect(
      describeInvocationStatus({
        modelIdentity: { requested: 'claude-fable-5', served: 'claude-fable-5', match: 'exact' },
      }),
    ).toBeNull();
    expect(
      describeInvocationStatus({
        modelIdentity: { requested: null, served: null, match: 'unknown' },
      }),
    ).toBeNull();
  });

  // A differs with no served string has nothing to name — do not render "served null".
  it('says nothing for a differs with no served model', () => {
    expect(
      describeInvocationStatus({
        modelIdentity: { requested: 'claude-fable-5', served: null, match: 'differs' },
      }),
    ).toBeNull();
  });

  it('says nothing for a clean run', () => {
    expect(describeInvocationStatus({})).toBeNull();
    expect(describeInvocationStatus({ providerFatalClass: null, modelIdentity: null })).toBeNull();
  });

  // A refused run never produced a served model, but if both were ever present the refusal is
  // the fact that explains the empty output.
  it('prefers the refusal when both a refusal and a swap are present', () => {
    const s = describeInvocationStatus({
      providerFatalClass: 'content_filter',
      modelIdentity: { requested: 'a', served: 'b', match: 'differs' },
    });
    expect(s?.headline).toMatch(/refused this request/i);
  });
});
