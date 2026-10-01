import { z } from 'zod';

/** Repository-relative directory holding the record, one file per merge unit. */
export const PROJECT_STATE_DIR = '.haive-data/state';

/** The record format this release reads and writes. A record written by a newer one is refused. */
export const PROJECT_STATE_FORMAT = 1;

/** Settings whose value is a set of strings: written sorted, merged member by member. A setting
 *  belongs here only while an absent one and an empty one mean the same, since a member merge can
 *  empty it and a merged set is written back as the file's whole value. */
export const SET_SETTINGS: ReadonlySet<string> = new Set(['scope-exclude-globs']);

/** Render keys merged member by member rather than as one value. `acceptedAgentIds` is deliberately
 *  NOT one: an empty list there means "no snapshot", which renders EVERY applicable agent
 *  (`template-manifest.ts`), so two installs each dropping what the other kept would merge to a
 *  wider set than either chose. It stays one value, and a person answers the conflict. */
export const RENDER_SET_KEYS: ReadonlySet<string> = new Set(['lspLanguages']);

const jsonObject = z.record(z.string(), z.unknown());

export const formatSchema = z.strictObject({ schemaVersion: z.number().int().positive() });

export const environmentSchema = z.strictObject({
  envDetectData: jsonObject,
  confirmedValues: jsonObject,
});

export const renderSchema = z.strictObject({
  projectInfo: jsonObject,
  framework: z.string().nullable(),
  acceptedAgentIds: z.array(z.string()),
  customAgentSpecs: z.array(jsonObject),
  lspLanguages: z.array(z.string()),
});

export const cliSchema = z.strictObject({ provider: z.string() });

export const claimSchema = z.strictObject({
  path: z.string(),
  templateId: z.string().min(1),
  kind: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  templateHash: z.string(),
  writtenHash: z.string(),
  haiveVersion: z.string(),
});

export const bundleSchema = z.strictObject({ source: z.string().min(1), name: z.string() });

export type ProjectEnvironment = z.infer<typeof environmentSchema>;
export type ProjectRender = z.infer<typeof renderSchema>;
export type ProjectStateClaim = z.infer<typeof claimSchema>;
export type ProjectStateBundle = z.infer<typeof bundleSchema>;

export interface ProjectStateRecord {
  environment: ProjectEnvironment | null;
  render: ProjectRender | null;
  /** The repository's CLI set, by provider name. */
  cli: string[];
  /** Portable settings by name. A name that is absent is unset; none holds null. */
  settings: Record<string, unknown>;
  /** One per disk path. */
  claims: ProjectStateClaim[];
  /** One per source. */
  bundles: ProjectStateBundle[];
}

export const emptyProjectState = (): ProjectStateRecord => ({
  environment: null,
  render: null,
  cli: [],
  settings: Object.create(null) as Record<string, unknown>,
  claims: [],
  bundles: [],
});
