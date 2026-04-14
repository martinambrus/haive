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
