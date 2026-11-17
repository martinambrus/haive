import { defaultDockerRunner, type DockerRunner } from '../../../sandbox/docker-runner.js';
import { createVerifyEnvironmentStep } from '../env-replicate/04-verify-environment.js';

/** Shares the image checks, with its own row, generation and task epoch. */
export function createVerifyComposedLspStep(runner: DockerRunner) {
  return createVerifyEnvironmentStep(runner, 'final');
}
export const verifyComposedLspStep = createVerifyComposedLspStep(defaultDockerRunner);
