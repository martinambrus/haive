import { z } from 'zod';

/** Per-bundle drift summary so the banner can group "custom.*" template
 *  changes by their owning bundle (e.g. "Bundle X: 3 changed items"). The
 *  field is optional — clients written before bundle support shipped should
 *  treat its absence as zero custom drift. */
export const upgradeStatusBundleChangeSchema = z.object({
  bundleId: z.string().uuid(),
  bundleName: z.string(),
  changedItemCount: z.number().int().nonnegative(),
});

export type UpgradeStatusBundleChange = z.infer<typeof upgradeStatusBundleChangeSchema>;

export const upgradeStatusResponseSchema = z.object({
  repositoryId: z.string().uuid(),
  hasUpgradeAvailable: z.boolean(),
  installedTemplateSetHash: z.string().nullable(),
  currentTemplateSetHash: z.string(),
  changedTemplateIds: z.array(z.string()),
  isOnboarded: z.boolean(),
  /** Most recent Haive release version recorded on a live artifact row. Null
   *  when the repo was onboarded before version tracking (pre-migration 0011)
   *  or has no live rows at all. */
  installedHaiveVersion: z.string().nullable(),
  /** Current running Haive release version. */
  currentHaiveVersion: z.string(),
  /** True if at least one onboarding_upgrade task already completed for this
   *  repo and there are still changes available. Drives the "Continue
   *  upgrade" banner state that follows a partial apply. */
  hasInProgressUpgradeSession: z.boolean(),
  /** True if at least one completed (non-rollback) onboarding_upgrade task
   *  exists for this repo. Drives whether the "Roll back last upgrade"
   *  button is shown — there's nothing to revert to without a prior upgrade. */
  hasPriorUpgrade: z.boolean(),
  /** Per-bundle drift breakdown. Optional for backwards compatibility; older
   *  servers may omit it entirely. */
  customChanges: z.array(upgradeStatusBundleChangeSchema).optional(),
});

export type UpgradeStatusResponse = z.infer<typeof upgradeStatusResponseSchema>;

export const rollbackUpgradeResponseSchema = z.object({
  taskId: z.string().uuid(),
});

export type RollbackUpgradeResponse = z.infer<typeof rollbackUpgradeResponseSchema>;
