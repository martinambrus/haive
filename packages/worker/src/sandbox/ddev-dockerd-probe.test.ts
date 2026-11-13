import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DDEV_DOCKERD_PROBE } from './ddev-runner.js';

describe('nested dockerd probe protocol', () => {
  it.each([
    { process: 0, info: 0, exit: 0, output: 'up\n' },
    { process: 1, info: 0, exit: 0, output: 'down\n' },
    { process: 2, info: 0, exit: 2, output: '' },
    { process: 3, info: 0, exit: 3, output: '' },
    { process: 127, info: 0, exit: 127, output: '' },
    { process: 0, info: 1, exit: 1, output: '' },
    { process: 0, info: 125, exit: 125, output: '' },
  ])('pgrep=$process and info=$info produce exit $exit / $output', (state) => {
    // Exercise the real shell branching with fake programs. No Docker is run.
    const result = spawnSync(
      'sh',
      [
        '-c',
        `pgrep() { return ${state.process}; }
docker() { echo 'arbitrary daemon stdout'; return ${state.info}; }
${DDEV_DOCKERD_PROBE}`,
      ],
      { encoding: 'utf8', timeout: 1000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(state.exit);
    expect(result.stdout).toBe(state.output);
  });
});
