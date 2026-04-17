import { schema } from '@haive/database';

export type CliProviderRecord = typeof schema.cliProviders.$inferSelect;
export type CliProviderName = CliProviderRecord['name'];
export type CliAuthMode = CliProviderRecord['authMode'];

export interface InvokeOpts {
  cwd?: string;
  timeoutMs?: number;
  modelOverride?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  extraEnv?: Record<string, string>;
  sessionId?: string;
  nonInteractive?: boolean;
  /** Per-call override for reasoning/effort level. Must be a value from the
   *  adapter's effortScale. When unset the adapter falls back to
   *  provider.effortLevel, then to the adapter's effortScale.max. Adapters
   *  with effortScale=null ignore this option. */
  effortLevel?: string;
}

export interface EffortScale {
  /** Allowed level identifiers for this CLI, ordered low-to-high. */
  values: readonly string[];
  /** Identifier corresponding to the highest effort. Used as the default
   *  when no per-provider override is set. */
  max: string;
}

export interface CliCommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface ApiCallSpec {
  sdkPackage: string;
  defaultModel: string;
  apiKeyEnvName: string;
  baseUrl?: string;
  prompt: string;
  model: string;
  maxOutputTokens: number;
}

export interface SubAgent {
  name: string;
  prompt: string;
  outputKey: string;
}

export interface SubAgentSpec {
  subAgents: SubAgent[];
  synthesisPrompt: string;
}

export type SubAgentInvocationMode = 'native' | 'sequential';

export interface SubAgentInvocationStep {
  id: string;
  prompt: string;
  expectJsonOutput: boolean;
  collectInto?: string;
}

export interface SubAgentInvocation {
  mode: SubAgentInvocationMode;
  steps: SubAgentInvocationStep[];
  synthesis: SubAgentInvocationStep;
}

export interface EnvCopyPath {
  src: string;
  dest: string;
  mode?: 'file' | 'dir';
  optional?: boolean;
}

export interface EnvInjection {
  envVars: Record<string, string>;
  copyPaths: EnvCopyPath[];
  extraArgs: string[];
}

export interface ProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export type LspLanguage = 'typescript' | 'python' | 'go' | 'rust' | 'php' | 'php-extended';

export interface PluginInstallOpts {
  repoRoot: string;
  lspLanguages: LspLanguage[];
  drupalLspPath?: string;
}

export interface PluginInstallCommand {
  description: string;
  command: string;
  args: string[];
}
