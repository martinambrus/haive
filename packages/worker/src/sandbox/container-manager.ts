import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import type { MountSpec } from '@haive/shared';
import {
  ClawkerClient,
  ClawkerBinaryMissingError,
  type ClawkerRunParams,
} from './clawker-client.js';

const log = logger.child({ module: 'container-manager' });

export type ContainerRow = typeof schema.containers.$inferSelect;

export interface ContainerCreateParams {
  taskId: string;
  image: string;
  agent?: string;
  project?: string;
  command?: string[];
  workingDir?: string;
  envVars?: Record<string, string>;
  mounts?: MountSpec[];
  tty?: boolean;
  openStdin?: boolean;
  allowedDomains?: string[];
  memoryLimitMb?: number;
  cpuLimitMilli?: number;
}

export interface ContainerManagerOptions {
  db: Database;
  clawker?: ClawkerClient;
  docker?: Docker;
}

type ContainerUpdatePatch = Partial<{
  status: ContainerRow['status'];
  dockerContainerId: string | null;
  destroyedAt: Date | null;
  pid: number | null;
  envVars: Record<string, string> | null;
  mountPaths: Record<string, string> | null;
}>;

export class ContainerManager {
  private readonly db: Database;
  private readonly clawker: ClawkerClient;
  private readonly docker: Docker;

  constructor(opts: ContainerManagerOptions) {
    this.db = opts.db;
    this.clawker = opts.clawker ?? new ClawkerClient();
    this.docker = opts.docker ?? new Docker();
  }

  get clawkerClient(): ClawkerClient {
    return this.clawker;
  }

  get dockerClient(): Docker {
    return this.docker;
  }

  async create(params: ContainerCreateParams): Promise<ContainerRow> {
    const project = params.project ?? this.clawker.project;
    const agent = params.agent ?? `task-${params.taskId.slice(0, 8)}`;
    const containerName = `clawker.${project}.${agent}`;

    const inserted = await this.db
      .insert(schema.containers)
      .values({
        taskId: params.taskId,
        runtime: 'clawker',
        name: containerName,
        status: 'creating',
        mountPaths: mountPathsToJson(params.mounts ?? []),
        envVars: params.envVars ?? {},
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error('Failed to insert container row');
    }

    try {
      const runParams: ClawkerRunParams = {
        agent,
        project,
        image: params.image,
      };
      if (params.command) runParams.command = params.command;
      if (params.workingDir) runParams.workingDir = params.workingDir;
      if (params.envVars) runParams.envVars = params.envVars;
      if (params.mounts) runParams.mounts = params.mounts;
      if (params.tty) runParams.tty = true;
      if (params.openStdin) runParams.openStdin = true;
      if (params.allowedDomains) runParams.allowedDomains = params.allowedDomains;
      if (params.memoryLimitMb !== undefined) runParams.memoryLimitMb = params.memoryLimitMb;
      if (params.cpuLimitMilli !== undefined) runParams.cpuLimitMilli = params.cpuLimitMilli;

      const result = await this.clawker.run(runParams);
      const dockerContainerId = await this.resolveDockerContainerId(result.containerName);
      return await this.update(row.id, {
        status: 'running',
        dockerContainerId,
      });
    } catch (err) {
      log.error({ err, containerRowId: row.id, taskId: params.taskId }, 'container create failed');
      await this.update(row.id, { status: 'error' }).catch(() => undefined);
      throw err;
    }
  }

  async get(id: string): Promise<ContainerRow | null> {
    const rows = await this.db
      .select()
      .from(schema.containers)
      .where(eq(schema.containers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByTask(taskId: string): Promise<ContainerRow[]> {
    return this.db.select().from(schema.containers).where(eq(schema.containers.taskId, taskId));
  }

  async stop(id: string, opts: { timeoutSec?: number } = {}): Promise<ContainerRow> {
    const row = await this.requireRow(id);
    if (row.status === 'stopped' || row.status === 'destroyed') return row;
    const agent = extractAgent(row.name);
    if (agent) {
      try {
        const stopOpts: { timeoutSec?: number } = {};
        if (opts.timeoutSec !== undefined) stopOpts.timeoutSec = opts.timeoutSec;
        await this.clawker.stop(agent, stopOpts);
      } catch (err) {
        if (err instanceof ClawkerBinaryMissingError && row.dockerContainerId) {
          await this.docker
            .getContainer(row.dockerContainerId)
            .stop()
            .catch(() => undefined);
        } else {
          throw err;
        }
      }
    } else if (row.dockerContainerId) {
      await this.docker
        .getContainer(row.dockerContainerId)
        .stop()
        .catch(() => undefined);
    }
    return this.update(id, { status: 'stopped' });
  }

  async destroy(id: string, opts: { force?: boolean } = {}): Promise<ContainerRow> {
    const row = await this.requireRow(id);
    if (row.status === 'destroyed') return row;
    const force = opts.force ?? true;
    const agent = extractAgent(row.name);
    if (agent) {
      try {
        await this.clawker.destroy(agent, { force });
      } catch (err) {
        if (err instanceof ClawkerBinaryMissingError && row.dockerContainerId) {
          await this.docker
            .getContainer(row.dockerContainerId)
            .remove({ force })
            .catch(() => undefined);
        } else {
          throw err;
        }
      }
    } else if (row.dockerContainerId) {
      await this.docker
        .getContainer(row.dockerContainerId)
        .remove({ force })
        .catch(() => undefined);
    }
    return this.update(id, { status: 'destroyed', destroyedAt: new Date() });
  }

  async markRunning(id: string, dockerContainerId: string): Promise<ContainerRow> {
    return this.update(id, { status: 'running', dockerContainerId });
  }

  async markError(id: string): Promise<ContainerRow> {
    return this.update(id, { status: 'error' });
  }

  async incrementAttached(id: string): Promise<number> {
    const row = await this.requireRow(id);
    const next = row.attachedWsCount + 1;
    await this.db
      .update(schema.containers)
      .set({ attachedWsCount: next })
      .where(eq(schema.containers.id, id));
    return next;
  }

  async decrementAttached(id: string): Promise<number> {
    const row = await this.requireRow(id);
    const next = Math.max(0, row.attachedWsCount - 1);
    await this.db
      .update(schema.containers)
      .set({ attachedWsCount: next })
      .where(eq(schema.containers.id, id));
    return next;
  }

  async resolveDockerContainerId(containerName: string): Promise<string | null> {
    try {
      const list = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({ name: [containerName] }),
      });
      const match = list.find((c) =>
        c.Names.some((n) => n === `/${containerName}` || n === containerName),
      );
      return match?.Id ?? null;
    } catch (err) {
      log.warn({ err, containerName }, 'failed to resolve docker container id');
      return null;
    }
  }

  private async update(id: string, patch: ContainerUpdatePatch): Promise<ContainerRow> {
    const rows = await this.db
      .update(schema.containers)
      .set(patch)
      .where(eq(schema.containers.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Container ${id} not found`);
    return row;
  }

  private async requireRow(id: string): Promise<ContainerRow> {
    const row = await this.get(id);
    if (!row) throw new Error(`Container ${id} not found`);
    return row;
  }
}

function extractAgent(containerName: string | null): string | null {
  if (!containerName) return null;
  const parts = containerName.split('.');
  if (parts.length < 3) return null;
  return parts.slice(2).join('.');
}

export interface TaskResourceLimits {
  memoryLimitMb?: number;
  cpuLimitMilli?: number;
}

export async function loadTaskResourceLimits(
  db: Database,
  taskId: string,
): Promise<TaskResourceLimits> {
  const row = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { memoryLimitMb: true, cpuLimitMilli: true },
  });
  const out: TaskResourceLimits = {};
  if (row?.memoryLimitMb != null) out.memoryLimitMb = row.memoryLimitMb;
  if (row?.cpuLimitMilli != null) out.cpuLimitMilli = row.cpuLimitMilli;
  return out;
}

function mountPathsToJson(mounts: MountSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mounts) {
    out[m.source] = m.target;
  }
  return out;
}
