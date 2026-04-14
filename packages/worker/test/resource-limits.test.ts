import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { ClawkerClient } from '../src/sandbox/clawker-client.js';
import { loadTaskResourceLimits } from '../src/sandbox/container-manager.js';

describe('ClawkerClient.buildRunArgs resource limits', () => {
  it('emits --memory and --cpus when both limits are set', () => {
    const client = new ClawkerClient({ binary: '/bin/true' });
    const args = client.buildRunArgs({
      agent: 'a',
      project: 'p',
      image: 'busybox',
      memoryLimitMb: 512,
      cpuLimitMilli: 1500,
    });
    const memIdx = args.indexOf('--memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);
    expect(args[memIdx + 1]).toBe('512m');
    const cpuIdx = args.indexOf('--cpus');
    expect(cpuIdx).toBeGreaterThanOrEqual(0);
    expect(args[cpuIdx + 1]).toBe('1.500');
  });

  it('omits limit flags when neither limit is set', () => {
    const client = new ClawkerClient({ binary: '/bin/true' });
    const args = client.buildRunArgs({
      agent: 'a',
      project: 'p',
      image: 'busybox',
    });
    expect(args).not.toContain('--memory');
    expect(args).not.toContain('--cpus');
  });

  it('emits only --memory when cpu limit is omitted', () => {
    const client = new ClawkerClient({ binary: '/bin/true' });
    const args = client.buildRunArgs({
      agent: 'a',
      project: 'p',
      image: 'busybox',
      memoryLimitMb: 256,
    });
    expect(args).toContain('--memory');
    expect(args).not.toContain('--cpus');
  });

  it('renders sub-core cpu limits with three decimals', () => {
    const client = new ClawkerClient({ binary: '/bin/true' });
    const args = client.buildRunArgs({
      agent: 'a',
      project: 'p',
      image: 'busybox',
      cpuLimitMilli: 250,
    });
    const cpuIdx = args.indexOf('--cpus');
    expect(args[cpuIdx + 1]).toBe('0.250');
  });
});

describe('loadTaskResourceLimits', () => {
  function makeDb(
    row: { memoryLimitMb: number | null; cpuLimitMilli: number | null } | null,
  ): Database {
    return {
      query: {
        tasks: {
          async findFirst() {
            return row;
          },
        },
      },
    } as unknown as Database;
  }

  it('returns both limits when set', async () => {
    const db = makeDb({ memoryLimitMb: 2048, cpuLimitMilli: 2000 });
    const limits = await loadTaskResourceLimits(db, 'task-id');
    expect(limits.memoryLimitMb).toBe(2048);
    expect(limits.cpuLimitMilli).toBe(2000);
  });

  it('returns empty object when task not found', async () => {
    const db = makeDb(null);
    const limits = await loadTaskResourceLimits(db, 'task-id');
    expect(limits).toEqual({});
  });

  it('omits null limits', async () => {
    const db = makeDb({ memoryLimitMb: 1024, cpuLimitMilli: null });
    const limits = await loadTaskResourceLimits(db, 'task-id');
    expect(limits.memoryLimitMb).toBe(1024);
    expect(limits.cpuLimitMilli).toBeUndefined();
  });
});
