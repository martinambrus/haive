import type { CliProviderName } from '../types/index.js';

export type ContainerRuntime = 'clawker' | 'dockerode';

export type ContainerStatus = 'creating' | 'running' | 'stopped' | 'destroyed' | 'error';

export interface MountSpec {
  source: string;
  target: string;
  mode: 'bind' | 'volume';
  readOnly?: boolean;
}

export interface RunContainerOptions {
  image: string;
  name?: string;
  command?: string[];
  workingDir?: string;
  envVars?: Record<string, string>;
  mounts?: MountSpec[];
  tty?: boolean;
  openStdin?: boolean;
  cliProvider?: CliProviderName;
  project?: string;
  allowedDomains?: string[];
  memoryLimitMb?: number;
  cpuLimitMilli?: number;
}

export interface ContainerHandle {
  id: string;
  taskId: string;
  runtime: ContainerRuntime;
  dockerContainerId: string;
  name: string;
  status: ContainerStatus;
}

export interface AttachOptions {
  tty?: boolean;
  cmd?: string[];
}

export type TerminalFrameType =
  | 'input'
  | 'output'
  | 'resize'
  | 'connected'
  | 'exit'
  | 'error'
  | 'ping'
  | 'pong'
  | 'set_control_passthrough'
  | 'oauth_prompt';

export interface InputFrame {
  type: 'input';
  data: string;
}

export interface OutputFrame {
  type: 'output';
  data: string;
}

export interface ResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface ConnectedFrame {
  type: 'connected';
  sessionId: string;
}

export interface ExitFrame {
  type: 'exit';
  code: number;
  reason?: string;
}

export interface ErrorFrame {
  type: 'error';
  message: string;
}

export interface PingFrame {
  type: 'ping';
}

export interface PongFrame {
  type: 'pong';
}

export interface SetControlPassthroughFrame {
  type: 'set_control_passthrough';
  allow: boolean;
}

export interface OAuthPromptFrame {
  type: 'oauth_prompt';
  url: string;
  service?: string;
}

export type TerminalFrame =
  | InputFrame
  | OutputFrame
  | ResizeFrame
  | ConnectedFrame
  | ExitFrame
  | ErrorFrame
  | PingFrame
  | PongFrame
  | SetControlPassthroughFrame
  | OAuthPromptFrame;

export type TerminalClientFrame = InputFrame | ResizeFrame | PingFrame | SetControlPassthroughFrame;

export type TerminalServerFrame =
  | OutputFrame
  | ConnectedFrame
  | ExitFrame
  | ErrorFrame
  | PongFrame
  | OAuthPromptFrame;
