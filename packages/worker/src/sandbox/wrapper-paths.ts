/** Shared by dispatch materialization and boot cleanup; resolve at use time. */
export const wrapperWorkerRoot = () =>
  process.env.SANDBOX_WRAPPER_WORKER_PATH ?? '/var/lib/haive/wrappers';
