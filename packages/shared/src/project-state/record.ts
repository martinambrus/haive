import { z } from 'zod';

/** Repository-relative directory holding the record, one file per merge unit. */
export const PROJECT_STATE_DIR = '.haive-data/state';

/** The record format this release reads and writes. A record written by a newer one is refused. */
export const PROJECT_STATE_FORMAT = 1;

/** Settings whose value is a set of strings: written sorted, merged member by member. */
export const SET_SETTINGS: ReadonlySet<string> = new Set(['scope-exclude-globs']);

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
  settings: {},
  claims: [],
  bundles: [],
});
