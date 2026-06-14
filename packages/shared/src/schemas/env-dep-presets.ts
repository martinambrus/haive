import { z } from 'zod';

/** Upsert body for a reusable per-repository env-replicate step preset (a named
 *  snapshot of a step's form inputs — step 1 `01-declare-deps` deps, or step 2
 *  `02-generate-dockerfile` Dockerfile). Keyed by (repositoryId, stepId, name);
 *  saving with an existing name on the same repo + step overwrites it. `values`
 *  is the raw step FormValues object — its exact shape is owned by the step's
 *  `form()`, so it is validated loosely here and re-seeded through the form
 *  renderer's defaults on apply. */
export const envDepPresetUpsertSchema = z.object({
  repositoryId: z.string().uuid(),
  stepId: z.string().trim().min(1).max(128).default('01-declare-deps'),
  name: z.string().trim().min(1).max(255),
  values: z.record(z.string(), z.unknown()),
  // When true the preset is global (reusable across all of the user's repos),
  // stored with no repository. repositoryId above is still the context repo,
  // used to validate ownership.
  global: z.boolean().default(false),
});

export type EnvDepPresetUpsert = z.infer<typeof envDepPresetUpsertSchema>;
