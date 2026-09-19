import type { DockerRunner } from '../src/sandbox/docker-runner.js';

/**
 * A DockerRunner for tests: every method throws unless the case supplies it.
 *
 * A fake that quietly answered a call nobody expected would let a test pass for the
 * wrong reason, and the interface has grown methods (inspect, remove, the volume
 * calls) that the hand-written fakes never implemented — which only a type check of
 * the test files could see.
 */
export function fakeDockerRunner(overrides: Partial<DockerRunner> = {}): DockerRunner {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`fake DockerRunner: ${name}() was not expected by this test`);
  };
  return {
    build: unexpected('build'),
    run: unexpected('run'),
    inspect: unexpected('inspect'),
    remove: unexpected('remove'),
    volumeCreate: unexpected('volumeCreate'),
    volumeExists: unexpected('volumeExists'),
    volumeRemove: unexpected('volumeRemove'),
    ...overrides,
  };
}
