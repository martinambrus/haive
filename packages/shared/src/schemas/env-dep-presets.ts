import { z } from 'zod';

/** Upsert body for a reusable per-repository dependency preset (the named
 *  snapshot of the env-replicate step-1 `01-declare-deps` form inputs). The
 *  preset is keyed by (repositoryId, name); saving with an existing name on the
 *  same repo overwrites it. `values` is the raw step-1 FormValues object — its
 *  exact shape is owned by the step's `form()`, so it is validated loosely
 *  here and re-seeded through the form renderer's defaults on apply. */
export const envDepPresetUpsertSchema = z.object({
  repositoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  values: z.record(z.string(), z.unknown()),
});

export type EnvDepPresetUpsert = z.infer<typeof envDepPresetUpsertSchema>;
