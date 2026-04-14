import type { StepRegistry } from '../../registry.js';
import { declareDepsStep } from './01-declare-deps.js';
import { generateDockerfileStep } from './02-generate-dockerfile.js';
import { buildImageStep } from './03-build-image.js';
import { verifyEnvironmentStep } from './04-verify-environment.js';

export { declareDepsStep, generateDockerfileStep, buildImageStep, verifyEnvironmentStep };
export { scanRepoForDeps } from './01-declare-deps.js';
export { renderDockerfile } from './02-generate-dockerfile.js';
export { createBuildImageStep } from './03-build-image.js';
export { buildSmokeChecks, createVerifyEnvironmentStep } from './04-verify-environment.js';

export function registerEnvReplicateSteps(registry: StepRegistry): void {
  registry.register(declareDepsStep);
  registry.register(generateDockerfileStep);
  registry.register(buildImageStep);
  registry.register(verifyEnvironmentStep);
}
