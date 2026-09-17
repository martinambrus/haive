import { z } from 'zod';

/** The grammar every bundle-supplied identifier must satisfy before it can become part of a path.
 *
 *  An agent's `id`, a skill's `id` and a sub-skill's `slug` are all interpolated into a `diskPath`
 *  by `template-manifest.ts`, so until this existed a bundle could name itself anything a string
 *  can hold and onboarding would write — and on upgrade DELETE — wherever that pointed.
 *
 *  Lowercase letters, digits and dashes, starting on a letter or a digit. A dot cannot appear at
 *  all, which is what rules out `..`, and neither can a slash or a NUL. MEASURED against every
 *  stored `custom_bundle_items` row before this shipped: 38 items, all 38 already conforming and 0
 *  with a null id, so no existing bundle is dropped by it and no migration is needed. Sub-skills
 *  were measured at the same time — not one stored row has any, so the `slug` rule constrains
 *  nothing that exists today either.
 *
 *  The message matters: a rejected item is dropped at parse time, and a malformed id is the one
 *  failure a bundle author can fix themselves, so the reason has to say what a valid id looks like
 *  rather than "invalid". */
export const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const bundleIdSchema = z
  .string()
  .min(1)
  .regex(
    BUNDLE_ID_PATTERN,
    'must be lowercase letters, digits and dashes only, starting with a letter or digit',
  );
