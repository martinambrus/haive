import manifest from '@haive/module-sdk-fixture/manifest';
import steps from '@haive/module-sdk-fixture/steps';
import type { WorkerModuleEntry } from '../../../src/modules/loader.js';

// The type conditions resolve source without emitting; runtime export conditions are tested separately.
export const entries = [
  { packageName: '@haive/module-sdk-fixture', manifest, steps } satisfies WorkerModuleEntry,
] as const;
