import manifest from '@haive/module-sdk-fixture/manifest';
import steps from '@haive/module-sdk-fixture/steps';
import type { WorkerModuleEntry } from '../../../src/modules/loader.js';

// Same static import/entry contract as the worker's generated registry, checked against built exports.
export const entries = [
  { packageName: '@haive/module-sdk-fixture', manifest, steps } satisfies WorkerModuleEntry,
] as const;
