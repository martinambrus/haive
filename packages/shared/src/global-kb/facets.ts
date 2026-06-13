// Project active-facet set derived from 01-env-detect output (plan §3.2). Used to
// filter the GLOBAL KB at query time so a project only retrieves stack/version-
// compatible house standards.

export interface ProjectFacetSet {
  framework: string[];
  frameworkMajor: string[];
  language: string[];
  phpMajor: string[];
  nodeMajor: string[];
  database: string[];
  dbMajor: string[];
  packages: string[];
  tags: string[];
  // A facet set is a dimension→values map; the index signature lets it satisfy
  // the search layer's generic Record<string, string[]> filter contract. The
  // named keys above document the known dimensions.
  [dimension: string]: string[];
}

export function emptyProjectFacetSet(): ProjectFacetSet {
  return {
    framework: [],
    frameworkMajor: [],
    language: [],
    phpMajor: [],
    nodeMajor: [],
    database: [],
    dbMajor: [],
    packages: [],
    tags: [],
  };
}

/** Major-version token from a version string: '8.3' -> '8', '^7.4.1' -> '7',
 *  '20' -> '20'. Null when there is no leading integer. */
export function majorOf(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = String(version).match(/\d+/);
  return m ? m[0] : null;
}

interface EnvDetectDataish {
  project?: {
    framework?: string;
    frameworkMajor?: string | null;
    packages?: string[];
    primaryLanguage?: string;
  };
  stack?: {
    language?: string | null;
    runtimeVersions?: Record<string, string>;
    database?: { type?: string | null; version?: string | null } | null;
  };
}

/** User overrides from the 02-detection-confirmation form, restricted to the
 *  fields that affect version facets. Confirmed values win over raw detection. */
export interface ConfirmedStackValues {
  phpVersion?: string | null;
  databaseType?: string | null;
  databaseVersion?: string | null;
}

/** Effective stack version facets: raw 01-env-detect values overlaid with the
 *  user's 02-confirmation overrides (which win). Shared by the query-side facet
 *  extractor and the write-side step 08 so both agree on the version anchors. */
export function resolveStackVersions(
  data: EnvDetectDataish,
  confirmed?: ConfirmedStackValues | null,
): {
  phpMajor: string | null;
  nodeMajor: string | null;
  database: string | null;
  dbMajor: string | null;
} {
  const rv = data?.stack?.runtimeVersions ?? {};
  const rawDb = data?.stack?.database ?? null;
  const dbType = confirmed?.databaseType ?? rawDb?.type ?? null;
  return {
    phpMajor: majorOf(confirmed?.phpVersion ?? rv.php),
    nodeMajor: majorOf(rv.node),
    database: dbType ? String(dbType).toLowerCase() : null,
    dbMajor: majorOf(confirmed?.databaseVersion ?? rawDb?.version),
  };
}

/** Extract the project facet set from a persisted 01-env-detect value, tolerating
 *  the detect-column shape ({ data: EnvDetectData }), the apply-output shape
 *  ({ enrichedData: EnvDetectData }), or a bare EnvDetectData (plan §3.2).
 *  `confirmed` overlays the user's 02-detection-confirmation overrides for the
 *  PHP/DB version anchors so a manually-entered version actually scopes the KB.
 *
 *  v1 is primary-language only; obvious secondary languages (a Drupal+Node repo)
 *  are the multi-stack risk noted in plan §9. */
export function extractProjectFacets(
  envDetect: unknown,
  confirmed?: ConfirmedStackValues | null,
): ProjectFacetSet {
  const facets = emptyProjectFacetSet();
  if (!envDetect || typeof envDetect !== 'object') return facets;
  const root = envDetect as Record<string, unknown>;
  const data = (root.data ?? root.enrichedData ?? root) as EnvDetectDataish;
  if (!data || typeof data !== 'object') return facets;

  const framework = data.project?.framework;
  if (typeof framework === 'string' && framework) facets.framework.push(framework);

  const frameworkMajor = data.project?.frameworkMajor;
  if (typeof frameworkMajor === 'string' && frameworkMajor) {
    facets.frameworkMajor.push(frameworkMajor);
  }

  const lang = data.project?.primaryLanguage ?? data.stack?.language ?? null;
  if (typeof lang === 'string' && lang) facets.language.push(lang.toLowerCase());

  const v = resolveStackVersions(data, confirmed);
  if (v.phpMajor) facets.phpMajor.push(v.phpMajor);
  if (v.nodeMajor) facets.nodeMajor.push(v.nodeMajor);
  if (v.database) facets.database.push(v.database);
  if (v.dbMajor) facets.dbMajor.push(v.dbMajor);

  const packages = data.project?.packages;
  if (Array.isArray(packages)) {
    for (const p of packages) if (typeof p === 'string' && p) facets.packages.push(p);
  }

  return facets;
}
