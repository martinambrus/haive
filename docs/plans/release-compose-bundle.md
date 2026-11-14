# T648 plan: the release manifest image carries the compose bundle; `haive upgrade` swaps it

PR1 shipped #1157; PR2 shipped #1172; PR3 shipped #1180; PR4 shipped #1181; PR5 implemented: journalled bundle backup, atomic swap, rollback/resume restoration and post-commit pruning (newest and edited/unknown backups retained).

## Context
- The installer downloads the compose bundle once, at the install tag: `install/install.sh:662-664`, plus the GPU or Vulkan overlay at `:688-696`. `install/install.ps1:557-558` does the same.
- `haive upgrade` only rewrites `.env` pins: `run.ts:78-84` (`setEnvVar`), `:106-108` (`writeImages`) and `:378-382` (`phaseVerify`). The updater's compose file list is hardcoded at `cli.ts:197-200`.
- Effect: an upgraded install keeps its old bundle. `docs/architecture/sandbox.md:317-320` already says such installs lack the ollama gate. An install whose `.env` has no `MAILPIT_UI_PASSWORD` gets an empty `MP_UI_AUTH` (`docker-compose.run.yml:134`), which means no login on the inbox.
- Separate bug found here: `cli.ts:197-200` never includes `docker-compose.gpu.yml` or `docker-compose.vulkan.yml`. The generated `./haive` helper does (`install.sh:799-800`). So every updater `compose up` (`run.ts:353`, `:382`, `:402`) recreates ollama without the GPU overlay.

## Current flow (file:line)

References re-checked against this change's HEAD. The approved Context below retains its original
wording; PR1 has already replaced the hardcoded updater compose list. The manifest contract below
includes PR2's required target files, history guards and env validation.

1. **Release build.** `.github/workflows/release.yml:212-223` runs `scripts/build-release-manifest.mjs` (`:140-155` builds the original object; `:157-164` optionally adds the bundle) to produce `release.json`. `:268-282` attaches it to the GitHub Release. The workflow does not yet pass `--bundle-dir`; no public manifest image is published.
2. **Channel build.** `scripts/publish-channel.mjs:398-408` git-archives `build-release-manifest.mjs` and the migrations from `record.commit`. `:415-427` runs the generator without `--bundle-dir` and parses the shared schema. `:491-523` builds `FROM scratch / COPY release.json` as `haive-<c>-release:<v>`, pushes it, and re-reads the digest.
3. **Manifest schema.** `packages/shared/src/release/manifest.ts:84-127` is a zod `z.object`. Unknown keys are stripped, so an older updater ignores a new optional field. The optional bundle schemas are at `:30-82`.
4. **Manifest read.** `packages/updater/src/cli.ts:107-140` (`loadManifest`):
   - Image reads require the image to be under `<channelRegistry>/haive-<c>-release:` (`:120-123`).
   - `channel` and `version` must match (`:135-138`).
   - The API's public URL defaults to GitHub HTTPS (`packages/api/src/routes/maintenance.ts:442-447`); the CLI loader also accepts explicit HTTP URLs or local paths (`cli.ts:132-134`).
   - Images are read by `packages/updater/src/docker.ts:399-424`, which calls `streamReleaseManifest` (`:330`). That function accepts only one regular `release.json` tar entry of at most 1 MiB, with checked headers (`:294-326`).
   - There is no signature anywhere. Default trust is the registry repository path or GitHub TLS.
5. **Upgrade order.** `packages/updater/src/cli.ts`:
   - installed compose list: `:198`, using `compose-context.ts:7-23` (PR1: base, run, then the installed GPU or Vulkan overlay)
   - lock and resume: `:282-330`
   - channel-change refusal: `:347-358`
   - `loadManifest`: `:366`
   - refusal `rollback-images-missing`: `:371-378`
   - `preflight`: `:382-395`
   - `--check`: `:398-404`
   - `prepareImages`, which pulls using the CURRENT compose files: `:407-414`
   - `startRun` (journal metadata `previousImages` and `targetImages`): `:417-427`
   - phases: `:449-481`
6. **Phases and rollback.** `packages/updater/src/phases.ts:66-99`: everything before `commit` is `reverse`, `commit` is `forward`. `run.ts:401-408` rollback rewrites the pins, runs compose up and restores the maintenance state. `resume`: `run.ts:435-443`. Verification still only rewrites image/version pins before compose up (`run.ts:381-396`); no bundle swap exists yet.
7. **Admin UI launch.** `packages/api/src/routes/maintenance.ts:533-590` runs the target version's `haive-updater:<v>` with `--manifest <url>` (`manifestUrl`, `:442-447`) or `--manifest-image`. The install directory is mounted at `/install`. The updater runs as root (`packages/updater/Dockerfile` has no `USER`).
8. **Installer `.env`.** `install/install.sh:704-766`: `rand_hex` (`:551-558`) generates `CONFIG_ENCRYPTION_KEY` (32 bytes), `JWT_SECRET` (32), `POSTGRES_PASSWORD` (16) and `MAILPIT_UI_PASSWORD` (24), with umask 077 and chmod 600. The `MP_UI_AUTH` detection is at `:667-671`. PowerShell uses the same byte counts (`install/install.ps1:580-583`) and writes the same keys (`:608-612`).

## Design

**Bundle contents.** A fixed allowlist: `docker-compose.yml`, `docker-compose.run.yml`, `docker-compose.gpu.yml`, `docker-compose.vulkan.yml`. Any other name is rejected by the schema. The `./haive` helper hardcodes file names, so new files cannot arrive silently.

**Required-key declaration.** A new checked-in file `install/bundle-env.json`, for example:
`[{ "key": "MAILPIT_UI_PASSWORD", "generate": "hex", "bytes": 24 }, { "key": "POSTGRES_PASSWORD", "generate": "never" }, { "key": "JWT_SECRET", "generate": "never" }, { "key": "CONFIG_ENCRYPTION_KEY", "generate": "never" }]`
- `hex` means the updater may create the key.
- `never` means the key must already exist. These are keys whose value is already in use (the database volume password, the encryption key for stored data), so a fresh value would break the install.

**Manifest addition** (`manifest.ts`, optional field, `manifestVersion` stays 1):
```
bundle?: { files: Record<AllowedName, 'sha256:<hex>'>,
           env: Array<{key, generate: 'hex'|'never', bytes?: 16..64}>,
           known: Array<Record<AllowedName,'sha256:<hex>'>> }
```
The target `files` requires base and run; overlays are optional, and historical `known` records
remain partial. `known` holds unique nonempty bundle hash records from `v*` tags merged into the
generating `HEAD`, excluding the target, in stable refname order. RC tags remain eligible so pristine
RC installs can be recognised. `build-release-manifest.mjs` computes them with `git show <tag>:<file>`.
With `--bundle-dir`, shallow checkouts always fail; an empty merged release-tag list fails unless
`--allow-no-history` is explicitly supplied for a tagless first release in a non-shallow checkout.
Both refusals exit non-zero, explain the failure on stderr and emit no stdout. PR3 must make
release.yml check out with `fetch-depth: 0` and fetch the release tags. Env keys must be unique;
unknown optional env fields are stripped, while `bytes` on `never` is rejected. The generator
validates the env declaration with the shared schema before embedding it.

**Where the bundle lives.**
- The image becomes `FROM scratch; COPY release.json /release.json; COPY bundle/ /bundle/`.
- Channel: extend `publish-channel.mjs:398-407` to git-archive the bundle files and `install/bundle-env.json` from `record.commit`, pass `--bundle-dir` to the manifest builder, and extend the context at `:490-496`. Update the recovery command at `:530-531`.
- Public: add a step in release.yml `release` after `:223` that builds `${IMAGE_PREFIX}-release:${VERSION}` for amd64 and arm64 with buildx, pushes it, and re-reads the digest. This must happen before `gh release create`.

**Verification.**
- Public: `release.json` still comes from the URL (the trust anchor today). Bundle files come from `ghcr.io/<owner>/haive-release:<v>`, and every file must match the URL's hashes, so the two sources check each other.
- Channel: `release.json` and the bundle come from the same image, already checked against the channel registry prefix (`cli.ts:119-123`). Each file must still match the hashes in the manifest.
- Both: compose files are trusted no more than images from the same registry, the same level as today. Signing (cosign) is noted as follow-up, not in scope.

**Extraction.**
- Generalise `streamReleaseManifest(id)` to `streamSingleFile(id, path, expectedName, max)`. Read each allowed file with a separate `docker cp <id>:/bundle/<name> -` (max 256 KiB each).
- This reuses the hardened header check: one regular entry with the exact name, no links. The image never supplies a path.
- `readReleaseManifestImage` returns `{ text, bundle?: Map<name, Buffer> }`, and the manifest container is created once.
- The installed overlay is read from the install directory, plus its counterpart file if it exists in the target bundle.

**Local-edit record.**
- New file `<install>/.haive-bundle.json` holds `{ version, files: {name: sha256} }`. It contains no secrets, mode 644.
- The installer writes it, and every completed swap rewrites it.

**Classifying the install** (new `bundle.ts`, called in preflight before any hold):
- `pristine`: the record exists and the files match it.
- `modified`: the record exists and some file differs.
- `legacy-known`: no record, and the files match an entry in `known`.
- `legacy-unknown`: no record and no match.

**Recommendation: refuse.** Both `modified` and `legacy-unknown` are refused with `refusal: 'bundle-modified'`: exit 3, an attempt row with the name of the first file that differs, no hold, nothing changed. Passing `--replace-modified-bundle` (host CLI, and a checkbox on the admin UI later) proceeds, and the edited files go into the backup.
- Why not keep the edited files with a warning: the install would then never receive the fail-closed changes this task exists for (`MP_UI_AUTH`, the ollama gate). A preflight refusal costs nothing, and the attempt-row banner already shows the operator why.
- `legacy-known` is adopted silently: it is pristine.

**Required keys** (`envkeys.ts`, run in preflight after classification, before `startRun`):
- For each `hex` key that is missing or empty: an empty value counts as missing because empty means no auth. Commented lines do not count. A non-empty value is never overwritten.
- A `never` key that is missing or empty refuses with `refusal: 'env-key-missing'` and the key name.
- Values come from `crypto.randomBytes(bytes).toString('hex')`.
- The write is one atomic step: read, append the lines, write `.env.haive-tmp` with the original mode, owner and group (fchown), fsync, rename.
- Only key names are logged or journalled (`metadata.envAdded: [names]`). Values never appear in argv, logs or errors.
- Running it again is safe because already-present keys are skipped.
- Done before the hold because the step only adds keys: the old bundle ignores unknown keys, or improves when a key it already references gets a value.
- Rollback leaves added keys in place, on purpose. Removing them could reopen a hole or break a run resumed forward.
- Then `docker compose -f <staged files> --project-directory <install> config -q` validates the staged bundle against the updated `.env`. Output is discarded the same way as `docker.ts:285-289` (compose can echo `.env` values).

**Staging, pull and backup.**
- Staged files are written to `<install>/.haive-upgrade/<runId|pending>/new/`.
- `prepareImages` (`cli.ts:409`) gets a compose context pointing at the staged files, so new services (ollama-gate) are pulled before the hold.
- Right after `startRun`, the current bundle files and `.haive-bundle.json` are copied to `.haive-upgrade/<runId>/previous/`. Their hashes go into `metadata.bundle = { from, to, backupDir, overlay }`; the journal uses JSONB, so no DDL change.
- A run that dies before the backup has changed no bundle file.

**Swap** (`phaseVerify`, `run.ts:378-382`):
- Order: `writeImages`, then `swapBundle(to)`, then `HAIVE_VERSION`, then `compose up` with the new file list.
- `swapBundle` does a temp-file-and-rename per file in the install directory, copying owner and mode from the file it replaces. `.haive-bundle.json` is renamed last.
- It is idempotent: a file whose hash already matches the target is skipped.

**Commit.** After marking the run done, `phaseCommit` keeps the newest `previous/` and prunes only
older backups classified `pristine` or `legacy-known`. The saved snapshot's classification is
persisted in `previous/.haive-backup-kind`. Edited, unknown and unclassified backups survive later
upgrades until manual deletion; each retained path is emitted as `bundle-backup-retained`.
Once a run is complete and its saved edits are no longer needed, the operator may delete that
run's `.haive-upgrade/<runId>/` directory. Never delete the backup of a running upgrade.

**Compose file list.** Replace the literal at `cli.ts:197-200` with base + run + the overlay detected in the install directory: `docker-compose.gpu.yml` or `docker-compose.vulkan.yml`, whichever the installer wrote. This fixes the GPU-overlay bug.

**Older targets and older installs.**
- A target manifest with no `bundle` field: skip the swap, emit `bundle-absent` and behave exactly as today. This covers upgrading to releases cut before this change.
- An install with no record is classified with `known`.

## Rollback path in plain English
If anything fails before the commit, the updater puts the old compose files back from the backup it took when the run started. Then it puts back the old image pins and the old `HAIVE_VERSION` in `.env`, restarts the stack on the old files, restores the maintenance state it found, and marks the run rolled back. Secrets it added to `.env` stay: they are harmless to the old release and may close a hole it had.

If the updater itself dies mid-swap, the next `haive upgrade` finds the run in the journal. It reads the backup location from the journal, compares each file's hash, restores any file that differs, and finishes the rollback. Once the commit has started there is no going back: the new bundle stays and the commit is finished forward, as for images today.

## PR split (each one reviewable alone)
1. **PR1: the updater uses the install's GPU or Vulkan overlay.**
   - Change: `cli.ts:197-200` and `ComposeContext` (`docker.ts:19-23`).
   - Controls: a unit test that the overlay is detected from the install directory, and that `composeArgs` keeps the order (base, run, overlay). A `run.test.ts` case that rollback and verify use the same list.
2. **PR2: manifest schema and generator.**
   - Change: `manifest.ts` (`bundle` with the file allowlist, hash regex, `bytes` bounds), `install/bundle-env.json`, and `build-release-manifest.mjs --bundle-dir` (file hashes, `env`, `known` from tags).
   - Controls: schema tests in a new `packages/shared/src/release/manifest.test.ts` (rejects other names, bad hashes, `bytes` out of range; a manifest without `bundle` still parses).
   - Consistency test in `scripts/test/`: every `${KEY}` the installer generates (`install.sh:707-710`) appears in `bundle-env.json` with the same byte count, and every `hex` key is referenced in the compose bundle.
3. **PR3: publish the bundle.**
   - Change: release.yml (fetch-depth 0, multi-arch build and push of `haive-release`, digest re-read, before the Release is created) and `publish-channel.mjs` (archive list, image context, recovery command).
   - Controls: extend `scripts/test/publish-channel.test.mjs` (image context lists `release.json` plus the allowed bundle files only; the manifest's hashes equal the archived bytes) and the workflow lint in `scripts/test/workflow.mjs`.
4. **PR4: the updater reads the bundle and adds required keys, with no swap yet.**
   - Change: generalised tar reader in `docker.ts`, a public bundle source (`--release-image`, defaulting to `<registry>/haive-release:<v>`), `bundle.ts` classification with the `bundle-modified` refusal and the flag, `envkeys.ts`, staged-compose pull and `config -q`.
   - Controls:
     - `manifest-docker.test.ts`: wrong entry name, a symlink entry, oversize, a hash mismatch, all refused.
     - `envkeys.test.ts`: missing, empty and commented keys filled; a non-empty value untouched; a second run makes no change; mode and owner kept; the value appears in no emitted event (spy on `emit`); a `never` key refused.
     - `channel-cli.test.ts`: the refusal rows (`bundle-modified`, `env-key-missing`) and `--check` writing nothing.
5. **PR5: swap and rollback.**
   - Change: backup after `startRun`, `swapBundle` in `phaseVerify`, restore in `rollback` and `resume`, pruning in commit, `metadata.bundle`.
   - Controls:
     - `run.test.ts`: a verify failure leaves the files byte-identical to before; a crash between file renames then a resume restores; the forward commit keeps the new files.
     - `test/rollback-failure-db.test.ts`: a run left `running` with `metadata.bundle` finishes its restore.
     - `phases.test.ts` unchanged, pinning that the swap stays before the commit pivot.
6. **PR6: installers and docs.**
   - Change: `install.sh` and `install.ps1` download `release.json` (`install.sh:607-611` already probes it), check the fetched files against `bundle.files` when present, and write `.haive-bundle.json`. Update `docs/architecture/release.md`, `modules.md:487` and `sandbox.md:317-320`, and the `./haive upgrade` usage text for `--replace-modified-bundle`.
   - Controls: `scripts/test/install-manifest.test.mjs` and `install-channel.test.mjs` (hash mismatch refused, record written), plus shellcheck (ci.yml:101).

## Verification
- **Unit and DB suites** per PR, as above; CI rows at ci.yml:592-600.
- **Two-install upgrade check** on throwaway installs only. Use install ids `t648a` and `t648b`, directories under the session scratchpad, ports from `free_port`, and never touch `haive-*`.
  1. Install the newest published release (0.2.0) twice with `install.sh --version 0.2.0 --dir ... --id t648a|t648b`.
  2. On t648b, delete the `MAILPIT_UI_PASSWORD` line from `.env` and edit one comment in `docker-compose.run.yml`.
  3. Cut an rc tag from the branch, or publish a test channel to a local `registry:3` with `publish-channel.mjs`.
  4. **t648a:** `./haive upgrade --version <rc>` exits 0.
     - `sha256sum` of the bundle equals the manifest.
     - `.haive-bundle.json` is present.
     - `ollama-gate` is running.
     - The mailpit UI answers 401 without credentials.
     - The `.env` key count is unchanged except for generated keys.
     - `grep -c` shows each key exactly once.
     - `docker logs` of the updater contains no generated value (search for the new value).
  5. **t648b:** exits 3 with `bundle-modified`, and a preflight attempt row exists.
     - `.env` and the files are byte-identical to before.
     - Rerun with `--replace-modified-bundle`: exits 0, the edited file is in `previous/`, `MAILPIT_UI_PASSWORD` is present and non-empty, and the mailpit UI requires login.
  6. **Rollback:** on a fresh t648a, force a verify failure (a target manifest with a wrong `migrationHead`, via a local channel). The files and pins equal the pre-run hashes, and the generated key remains.
  7. **Crash-resume:** `docker kill` the updater after the `verify-start` event, then run `./haive upgrade` again. The rollback restores the files.
  8. **Cleanup:** each install's own `./uninstall.sh`.

## Risks
- **No signatures.** The bundle trust equals today's manifest trust (registry repository or TLS). A compromised registry could already ship images, so the swap adds no new exposure; cosign is a follow-up.
- **The updater runs as root** on a bind-mounted host directory. Every file it creates must copy owner and mode from the file it replaces or from the install directory, or the operator ends up with root-owned files.
- **`.env` is edited by the updater while the api reads it** (the api does not re-read it). The atomic rename avoids a torn read. An operator editing `.env` at the same moment can lose their edit; the lock does not cover humans.
- **Compose across versions.** The new bundle is validated with the updater image's compose version, but the host helper uses the host's version. `!reset` already needs compose 2.24 or later. Document the minimum.
- **Removed services** become orphans: `compose up` does not remove them. Do not add `--remove-orphans` in this task; record it as a follow-up.
- **`known` hash list.** Any hand-patched release, including hotfix tags that rewrote a file, makes a legacy install read as `legacy-unknown` and refused. The flag is the way out, and the refusal message must name it.
- **Hardcoded file names** in the generated `./haive` helper and `uninstall.sh` mean a future bundle cannot add a file. The allowlist enforces that until a helper-refresh task exists.
- **Generated keys stay after a rollback.** This is intended. Document it so operators are not surprised.

### Critical Files for Implementation
- /home/zathrus/haive/packages/updater/src/cli.ts
- /home/zathrus/haive/packages/updater/src/run.ts
- /home/zathrus/haive/packages/updater/src/docker.ts
- /home/zathrus/haive/packages/shared/src/release/manifest.ts
- /home/zathrus/haive/scripts/publish-channel.mjs (with /home/zathrus/haive/.github/workflows/release.yml, /home/zathrus/haive/scripts/build-release-manifest.mjs and /home/zathrus/haive/install/install.sh)
