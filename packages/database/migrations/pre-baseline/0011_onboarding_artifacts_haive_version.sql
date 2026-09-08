-- Records the Haive release version that wrote each artifact row. Enables the
-- upgrade-status endpoint to report a "last upgraded at vX.Y.Z" version skew
-- line so users know how far behind their install has drifted. Nullable for
-- backward compatibility with rows written before this column existed — the
-- API treats null as "unknown version (pre-tracking)".

ALTER TABLE "onboarding_artifacts" ADD COLUMN "haive_version" varchar(32);
