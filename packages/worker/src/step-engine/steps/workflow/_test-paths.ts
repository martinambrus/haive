/** Existing 08b runner-file classifier. Evidence also includes harnesses, configs and fixtures. */
export const TEST_FILE_RE =
  /(\.(spec|test)\.[cm]?[jt]sx?|Test\.php|\.test\.php|(^|\/)test_[^/]+\.py|_test\.py)$/;

export const isTestEvidencePath = (path: string): boolean =>
  TEST_FILE_RE.test(path) ||
  /(^|\/)(scripts|\.github\/workflows)(\/|$)/i.test(path) ||
  /(^|\/)(setupTests|test[-_]setup|test[-_]harness|Jenkinsfile|\.gitlab-ci)(\.|$)/i.test(path) ||
  /(^|\/)(__tests__|__fixtures__|__snapshots__|tests?|testing|fixtures?|harness|e2e|cypress|playwright)(\/|$)/i.test(
    path,
  ) ||
  /(^|\/)([^/]*[.-])?(jest|vitest|playwright|cypress|karma|mocha|ava|phpunit|pytest|tox|conftest)([.-][^/]*)?$/i.test(
    path,
  ) ||
  /(^|\/)(package\.json|composer\.json|pyproject\.toml|setup\.cfg|\.nycrc.*|\.mocharc.*|testng\.xml|pom\.xml|build\.gradle.*|Makefile|justfile)$/i.test(
    path,
  );
