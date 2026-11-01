import { AsyncLocalStorage } from 'node:async_hooks';

// A data Save reports its own failures. Its nested flush/recovery calls must not attach
// those diagnoses to the plan snapshot, including when another job writes concurrently.
const dataSave = new AsyncLocalStorage<boolean>();
export const withoutPlanMirrorErrors = <T>(run: () => Promise<T>): Promise<T> =>
  dataSave.run(true, run);
export const planMirrorErrorsSuppressed = (): boolean => dataSave.getStore() === true;
