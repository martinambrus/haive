import { describe, it, expect } from 'vitest';
import { makeModelHealthStep, validateCanary } from './_model-health.js';

describe('validateCanary', () => {
  it('passes on the expected sentinel', () => {
    expect(() =>
      validateCanary('```json\n{"status":"ok","echo":"HAIVE_CANARY_OK"}\n```'),
    ).not.toThrow();
  });

  it('tolerates surrounding prose, case, and echo substring', () => {
    expect(() =>
      validateCanary(
        'Sure!\n```json\n{"status":"OK","echo":"prefix HAIVE_CANARY_OK suffix"}\n```\nDone.',
      ),
    ).not.toThrow();
  });

  it('accepts an already-parsed object (bypass-stub shape)', () => {
    expect(() => validateCanary({ status: 'ok', echo: 'HAIVE_CANARY_OK' })).not.toThrow();
  });

  it('throws on a chat greeting with no JSON', () => {
    expect(() => validateCanary('How can I help you today?')).toThrow(/fenced block|ignored/i);
  });

  it('throws on valid JSON that ignores the echo instruction', () => {
    expect(() => validateCanary('```json\n{"reply":"hello"}\n```')).toThrow(/echo|instruction/i);
  });

  it('throws on a wrong echo token', () => {
    expect(() => validateCanary('```json\n{"status":"ok","echo":"nope"}\n```')).toThrow();
  });

  it('throws on malformed JSON (no jsonrepair leniency)', () => {
    expect(() => validateCanary('```json\n{"status":"ok",}\n```')).toThrow(/parse/i);
  });

  it('throws on empty / null output', () => {
    expect(() => validateCanary('')).toThrow(/empty/i);
    expect(() => validateCanary(null)).toThrow(/empty/i);
  });

  it('embeds the raw model output in the failure message', () => {
    expect(() => validateCanary('Hello, I am an assistant.')).toThrow(/Hello, I am an assistant\./);
  });
});

describe('makeModelHealthStep', () => {
  it('builds an index-0 canary for the given pipeline', () => {
    const step = makeModelHealthStep('workflow');
    expect(step.metadata.id).toBe('00-model-health-workflow');
    expect(step.metadata.index).toBe(0);
    expect(step.metadata.workflowType).toBe('workflow');
    expect(step.metadata.requiresCli).toBe(true);
  });

  it('has a bypass stub that passes its own validation', () => {
    const step = makeModelHealthStep('onboarding');
    const stub = step.llm!.bypassStub!({ detected: null, formValues: {} });
    expect(() => validateCanary(stub)).not.toThrow();
  });
});
