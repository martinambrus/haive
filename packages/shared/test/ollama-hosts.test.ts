import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTERNAL_OLLAMA_URL,
  IN_STACK_OLLAMA_HOSTS,
  IN_STACK_OLLAMA_URL,
} from '../src/constants/index.js';

describe('in-stack Ollama constants', () => {
  it('hands out a URL its own host set recognises', () => {
    // The pairing is the whole reason these two live together. Callers ask
    // "is this the bundled daemon?" about a URL that other callers got from
    // IN_STACK_OLLAMA_URL when nothing was configured, so a change to either
    // that leaves them disagreeing makes the default fail its own check —
    // silently, since every consumer treats a non-match as "external".
    expect(IN_STACK_OLLAMA_HOSTS.has(new URL(IN_STACK_OLLAMA_URL).hostname)).toBe(true);
  });

  it('never treats localhost as the bundled daemon', () => {
    // Inside a cli-exec sandbox localhost is the sandbox itself. A provider
    // pointed there passed every check and then failed each step with
    // ECONNREFUSED, which is why this set stays narrow — step-runner's
    // isLocalOllama keeps its own wider one for a different question.
    expect(IN_STACK_OLLAMA_HOSTS.has('localhost')).toBe(false);
    expect(IN_STACK_OLLAMA_HOSTS.has('127.0.0.1')).toBe(false);
  });

  it('keeps the external default outside the in-stack set', () => {
    // Otherwise picking "external Ollama server" would resolve back to the
    // bundled one and the choice would do nothing.
    expect(IN_STACK_OLLAMA_HOSTS.has(new URL(DEFAULT_EXTERNAL_OLLAMA_URL).hostname)).toBe(false);
  });
});
