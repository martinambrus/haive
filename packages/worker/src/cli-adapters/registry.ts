import { AmpAdapter } from './amp.js';
import type { BaseCliAdapter } from './base-adapter.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import type { CliProviderName } from './types.js';
import { ZaiAdapter } from './zai.js';

export class CliAdapterRegistry {
  private readonly adapters = new Map<CliProviderName, BaseCliAdapter>();

  constructor() {
    this.register(new ClaudeCodeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiAdapter());
    this.register(new AmpAdapter());
    this.register(new ZaiAdapter());
  }

  private register(adapter: BaseCliAdapter): void {
    this.adapters.set(adapter.providerName, adapter);
  }

  get(providerName: CliProviderName): BaseCliAdapter {
    const adapter = this.adapters.get(providerName);
    if (!adapter) {
      throw new Error(`Unknown CLI provider: ${providerName}`);
    }
    return adapter;
  }

  has(providerName: CliProviderName): boolean {
    return this.adapters.has(providerName);
  }

  list(): BaseCliAdapter[] {
    return Array.from(this.adapters.values());
  }

  names(): CliProviderName[] {
    return Array.from(this.adapters.keys());
  }
}

export const cliAdapterRegistry = new CliAdapterRegistry();
