-- 02 mirrored 01's prompt-only detect fields (`__configContents`, `__repoIntel`) into the
-- environment, which 12 commits as `.haive-data/environment.json`. Nothing reads them, and a re-run
-- of 01 derives them again from the checkout, so this removal needs no undo.
UPDATE repositories
SET onboarding_environment = jsonb_set(
      onboarding_environment,
      '{envDetectData}',
      (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
       FROM jsonb_each(onboarding_environment->'envDetectData')
       WHERE NOT starts_with(key, '__')))
WHERE jsonb_typeof(onboarding_environment->'envDetectData') = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(onboarding_environment->'envDetectData') AS k
    WHERE starts_with(k, '__')
  );
