-- Collapse the two PHP LSP options into one. The plain `intelephense` env key
-- and its onboarding `php` LSP language were dropped: both installed the SAME
-- intelephense binary + drupal-php-lsp plugin as `intelephense-extended`, so the
-- distinction was a redundant tooling-page choice. `intelephense-extended` is the
-- single survivor (label "Intelephense (PHP)").
--
-- Normalize per-repo state written before the collapse so the tooling page and
-- 01-declare-deps no longer surface / re-emit the removed key:
--   * lsp_servers (text[]): map 'intelephense' -> 'intelephense-extended',
--     de-duped (a repo with BOTH keys collapses to one entry).
--   * lsp_server_versions (jsonb): rename the 'intelephense' pin key to
--     'intelephense-extended' (survivor pin wins if both keys already present).
--
-- Data-only + idempotent: re-running is a no-op once no row carries the legacy
-- key. Safe to re-run on every environment via `drizzle-kit push`.

UPDATE "repositories"
SET "lsp_servers" = (
  SELECT array_agg(DISTINCT v)
  FROM (
    SELECT CASE WHEN elem = 'intelephense' THEN 'intelephense-extended' ELSE elem END AS v
    FROM unnest("lsp_servers") AS elem
  ) mapped
)
WHERE "lsp_servers" IS NOT NULL
  AND 'intelephense' = ANY("lsp_servers");

UPDATE "repositories"
SET "lsp_server_versions" =
  ("lsp_server_versions" - 'intelephense')
  || CASE
       WHEN "lsp_server_versions" ? 'intelephense-extended' THEN '{}'::jsonb
       ELSE jsonb_build_object('intelephense-extended', "lsp_server_versions" -> 'intelephense')
     END
WHERE "lsp_server_versions" ? 'intelephense';
