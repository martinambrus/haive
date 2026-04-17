import { spawn } from 'node:child_process';
import type {
  ApiCallSpec,
  CliAuthMode,
  CliCommandSpec,
  CliProviderName,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
  ProbeResult,
  SubAgentInvocation,
  SubAgentSpec,
} from './types.js';

const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export abstract class BaseCliAdapter {
  abstract readonly providerName: CliProviderName;
  abstract readonly defaultExecutable: string;
  abstract readonly supportsSubagents: boolean;
  abstract readonly supportsApi: boolean;
  abstract readonly supportsCliAuth: boolean;
  abstract readonly supportsMcp: boolean;
  abstract readonly supportsPlugins: boolean;
  abstract readonly defaultAuthMode: CliAuthMode;
  abstract readonly apiKeyEnvName: string | null;
  abstract readonly defaultModel: string | null;

  async isAvailable(provider: CliProviderRecord): Promise<boolean> {
    const result = await this.probeExecutable(provider);
    return result.ok;
  }

  async probeExecutable(provider: CliProviderRecord): Promise<ProbeResult> {
    const executable = this.resolveExecutable(provider);
    return probeVersion(executable);
  }

  abstract buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec;

  buildApiInvocation?(provider: CliProviderRecord, prompt: string, opts: InvokeOpts): ApiCallSpec;

  buildSubAgentInvocation(
    _provider: CliProviderRecord,
    spec: SubAgentSpec,
    _opts: InvokeOpts,
  ): SubAgentInvocation {
    return {
      mode: 'native',
      steps: spec.subAgents.map((sub) => ({
        id: sub.name,
        prompt: sub.prompt,
        expectJsonOutput: true,
        collectInto: sub.outputKey,
      })),
      synthesis: {
        id: 'synthesis',
        prompt: spec.synthesisPrompt,
        expectJsonOutput: true,
      },
    };
  }

  abstract envInjection(provider: CliProviderRecord): EnvInjection;

  buildPluginInstallCommands?(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[];

  /** Env vars to inject when InvokeOpts.maxThinking is true. Default: none.
   *  Override per-adapter when the underlying CLI supports an effort/budget
   *  knob (e.g. CLAUDE_CODE_EFFORT_LEVEL=max). */
  maxThinkingEnv(): Record<string, string> {
    return {};
  }

  protected resolveExecutable(provider: CliProviderRecord): string {
    const wrapper = provider.wrapperPath?.trim();
    if (wrapper) return wrapper;
    const explicit = provider.executablePath?.trim();
    if (explicit) return explicit;
    return this.defaultExecutable;
  }

  protected mergedEnv(provider: CliProviderRecord, opts: InvokeOpts): Record<string, string> {
    const thinking = opts.maxThinking ? this.maxThinkingEnv() : {};
    return { ...(provider.envVars ?? {}), ...thinking, ...(opts.extraEnv ?? {}) };
  }

  protected mergedArgs(provider: CliProviderRecord, base: string[]): string[] {
    const stored = provider.cliArgs ?? [];
    return [...stored, ...base];
  }

  protected effectiveModel(opts: InvokeOpts): string {
    if (opts.modelOverride) return opts.modelOverride;
    if (this.defaultModel) return this.defaultModel;
    throw new Error(`${this.providerName} has no default model configured`);
  }

  protected effectiveMaxTokens(opts: InvokeOpts): number {
    return opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }
}

export async function probeVersion(
  executable: string,
  args: string[] = ['--version'],
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, version: stdout.trim() || stderr.trim() || undefined });
      } else {
        finish({ ok: false, error: stderr.trim() || `exit ${code ?? 'unknown'}` });
      }
    });
  });
}
