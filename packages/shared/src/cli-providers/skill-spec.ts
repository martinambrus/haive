import { z } from 'zod';

export const skillKeyConceptSchema = z.object({
  term: z.string(),
  definition: z.string(),
});
export type SkillKeyConcept = z.infer<typeof skillKeyConceptSchema>;

export const skillNamedBlockSchema = z.object({
  name: z.string(),
  body: z.string(),
});
export type SkillNamedBlock = z.infer<typeof skillNamedBlockSchema>;

export const skillPitfallSchema = z.object({
  title: z.string(),
  body: z.string(),
});
export type SkillPitfall = z.infer<typeof skillPitfallSchema>;

export const skillCodeLocationSchema = z.object({
  label: z.string(),
  path: z.string(),
});
export type SkillCodeLocation = z.infer<typeof skillCodeLocationSchema>;

const skillIdentificationRowSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const skillSubSkillSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().optional(),
  summary: z.string(),
  body: z.string(),
  identification: z.array(skillIdentificationRowSchema).optional(),
});
export type SkillSubSkill = z.infer<typeof skillSubSkillSchema>;

export const skillRelatedSchema = z.object({
  path: z.string(),
  summary: z.string(),
});
export type SkillRelated = z.infer<typeof skillRelatedSchema>;

/** Canonical IR for a skill. Same fields as the worker's runtime SkillEntry,
 *  promoted here so `@haive/shared` consumers (bundle parser, web UI) and
 *  the worker share one definition. The worker's `skillToMarkdown` /
 *  `subSkillToMarkdown` renderers are the source of truth for the on-disk
 *  format. */
export const skillEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().optional(),
  quickStart: z.string().optional(),
  overview: z.string().optional(),
  keyConcepts: z.array(skillKeyConceptSchema).optional(),
  quickReference: z.string().optional(),
  decisionTree: z.string().optional(),
  implementationPatterns: z.array(skillNamedBlockSchema).optional(),
  pitfalls: z.array(skillPitfallSchema).optional(),
  codeLocations: z.array(skillCodeLocationSchema).optional(),
  usage: z.string().optional(),
  subSkills: z.array(skillSubSkillSchema).optional(),
  relatedSkills: z.array(skillRelatedSchema).optional(),
  commonPatterns: z.array(skillNamedBlockSchema).optional(),
});
export type SkillEntry = z.infer<typeof skillEntrySchema>;
