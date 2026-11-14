import { describe, expect, it } from 'vitest';
import {
  disabledProvider,
  providerHoldMessage,
  providerLabel,
} from '../src/orchestrator/provider-hold.js';

const on = { id: 'on', enabled: true, label: 'On label', name: 'claude-code' };
const off = { id: 'off', enabled: false, label: 'Off label', name: 'codex' };
const unnamed = { id: 'bare', enabled: false, label: '', name: 'gemini' };
const providers = [on, off, unnamed];

describe('disabledProvider', () => {
  it('finds the provider with that id only when it is disabled', () => {
    expect(disabledProvider(providers, 'off')).toBe(off);
    expect(disabledProvider(providers, 'on')).toBeNull();
  });

  it('gives null for a null id or an id no provider has', () => {
    expect(disabledProvider(providers, null)).toBeNull();
    expect(disabledProvider(providers, 'missing')).toBeNull();
    expect(disabledProvider([], 'off')).toBeNull();
  });
});

describe('providerHoldMessage', () => {
  it('is null for a null, unlisted or enabled provider', () => {
    expect(providerHoldMessage(providers, null)).toBeNull();
    expect(providerHoldMessage(providers, 'missing')).toBeNull();
    expect(providerHoldMessage(providers, 'on')).toBeNull();
  });

  it('names the disabled provider by its label', () => {
    const message = providerHoldMessage(providers, 'off');
    expect(message).toContain('"Off label"');
    expect(message).toMatch(/disabled/);
    expect(message).toContain('Enable the provider again');
    expect(message).toContain("switch this step's CLI");
  });

  it('falls back to the provider name when the label is empty', () => {
    expect(providerLabel(unnamed)).toBe('gemini');
    expect(providerHoldMessage(providers, 'bare')).toContain('"gemini"');
  });
});
