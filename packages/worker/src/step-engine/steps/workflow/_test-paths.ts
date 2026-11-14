/** Existing 08b runner-file classifier. Evidence also includes harnesses, configs and fixtures. */
export const TEST_FILE_RE =
  /(\.(spec|test)\.[cm]?[jt]sx?|Test\.php|\.test\.php|(^|\/)test_[^/]+\.py|_test\.py)$/;

export const isTestEvidencePath = (path: string): boolean =>
  TEST_FILE_RE.test(path) ||
  /(_test\.go|_spec\.rb|Test\.(java|kt)|Tests\.cs)$/.test(path) ||
  /(^|\/)(scripts|\.github\/workflows)(\/|$)/i.test(path) ||
  /(^|\/)(setupTests|test[-_]setup|test[-_]harness|Jenkinsfile|\.gitlab-ci)(\.|$)/i.test(path) ||
  /(^|\/)(__tests__|__fixtures__|__snapshots__|tests?|spec|testing|fixtures?|harness|e2e|cypress|playwright)(\/|$)/i.test(
    path,
  ) ||
  /(^|\/)((jest|vitest|playwright|cypress|karma|mocha|ava)\.config\.[cm]?[jt]s|phpunit\.xml(\.dist)?|pytest\.ini|tox\.ini|conftest\.py)$/i.test(
    path,
  ) ||
  /(^|\/)(package\.json|composer\.json|pyproject\.toml|setup\.cfg|\.nycrc.*|\.mocharc.*|testng\.xml|pom\.xml|build\.gradle.*|Makefile|justfile)$/i.test(
    path,
  );
