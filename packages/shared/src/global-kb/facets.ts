// Project active-facet set derived from 01-env-detect output (plan §3.2). Used to
// filter the GLOBAL KB at query time so a project only retrieves stack/version-
// compatible house standards.

export interface ProjectFacetSet {
  framework: string[];
  language: string[];
  phpMajor: string[];
  nodeMajor: string[];
  packages: string[];
  tags: string[];
  // A facet set is a dimension→values map; the index signature lets it satisfy
  // the search layer's generic Record<string, string[]> filter contract. The
  // named keys above document the known dimensions.
  [dimension: string]: string[];
}

export function emptyProjectFacetSet(): ProjectFacetSet {
  return { framework: [], language: [], phpMajor: [], nodeMajor: [], packages: [], tags: [] };
}

/** Major-version token from a version string: '8.3' -> '8', '^7.4.1' -> '7',
 *  '20' -> '20'. Null when there is no leading integer. */
export function majorOf(version: string | null | undefined): string | null {
  if (!version) return null;
  const m = String(version).match(/\d+/);
  return m ? m[0] : null;
}

interface EnvDetectDataish {
  project?: { framework?: string; primaryLanguage?: string };
  stack?: { language?: string | null; runtimeVersions?: Record<string, string> };
}

/** Extract the project facet set from a persisted 01-env-detect value, tolerating
 *  the detect-column shape ({ data: EnvDetectData }), the apply-output shape
 *  ({ enrichedData: EnvDetectData }), or a bare EnvDetectData (plan §3.2).
 *
 *  v1 is primary-language only; obvious secondary languages (a Drupal+Node repo)
 *  are the multi-stack risk noted in plan §9. */
export function extractProjectFacets(envDetect: unknown): ProjectFacetSet {
  const facets = emptyProjectFacetSet();
  if (!envDetect || typeof envDetect !== 'object') return facets;
  const root = envDetect as Record<string, unknown>;
  const data = (root.data ?? root.enrichedData ?? root) as EnvDetectDataish;
  if (!data || typeof data !== 'object') return facets;

  const framework = data.project?.framework;
  if (typeof framework === 'string' && framework) facets.framework.push(framework);

  const lang = data.project?.primaryLanguage ?? data.stack?.language ?? null;
  if (typeof lang === 'string' && lang) facets.language.push(lang.toLowerCase());

  const rv = data.stack?.runtimeVersions ?? {};
  const php = majorOf(rv.php);
  if (php) facets.phpMajor.push(php);
  const node = majorOf(rv.node);
  if (node) facets.nodeMajor.push(node);

  return facets;
}
