# Haive Drupal 7 Fixture

Minimal Drupal 7 project layout used by `drupal7-onboarding-smoke.ts`. Not a
running site. Provides just enough structure for framework detection, agent
discovery, and RAG ingestion to exercise the drupal7 code paths:

- `.ddev/config.yaml` declares `type: drupal7`, MariaDB 10.11, PHP 7.4
- `includes/bootstrap.inc` triggers the drupal7 indicator
- `sites/default/settings.php` has a minimal database config
- `sites/all/modules/custom/` holds three hand-written modules (`haive_welcome`,
  `haive_api`, `haive_cache`) each with `.info`, `.module`, and `.install`
  files. Nine total .module/.install files cross the 5-file threshold for
  the `drupal-module-dev` agent recommendation in step `06_5-agent-discovery`.
- `sites/all/themes/haive_theme/` seeds a single-theme directory
- `modules/user/user.module` stubs the core modules directory indicator
