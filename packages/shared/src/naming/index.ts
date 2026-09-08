/**
 * Per-install resource naming.
 *
 * Every Docker container, volume, network and image this install owns, and every Postgres
 * database it creates, carries the install's identity. Without that, two Haive installs on one
 * machine collide — and the dangerous half is silent: five volumes in `docker-compose.yml` carry
 * an explicit global `name:`, so a second install MOUNTS the first one's cloned repositories and
 * its worker acts on them, and its RAG queries read the first install's vectors. Nothing errors.
 *
 * **The identity is the INSTALL, never the version.** A version in the name would rename every
 * container on every upgrade and rename them back on a rollback, breaking anything holding a name
 * and cutting logs and monitoring in half at each release. The version already lives in the image
 * tag and at `/version`, which is where a value that changes belongs.
 *
 * **The default output is byte-identical to the names that shipped before this module existed.**
 * That is what makes it deployable with no migration and no rename: an install that never sets
 * `HAIVE_INSTALL_ID` cannot tell the difference. `naming.test.ts` asserts it family by family.
 *
 * **Filters are built here too, next to the constructors, and that is the point of the module
 * rather than a convenience.** A prefix change that reaches the constructors but not a reaper's
 * filter produces one of two failures, and both are worse than the collision being fixed: too
 * narrow and resources leak forever with nothing reporting it; too broad and ONE INSTALL REAPS
 * ANOTHER'S containers, volumes and databases. No call site may type a `haive-` or `haive_`
 * literal — for either purpose.
 */

export const DEFAULT_INSTALL_ID = 'haive';

/**
 * What an install id may be: lower case, digits and underscores.
 *
 * Narrower than Docker allows, and the exclusion of `-` is forced by compose. The id is
 * interpolated into `docker-compose.yml` as BOTH `${HAIVE_INSTALL_ID}-api` (a container name) and
 * `${HAIVE_INSTALL_ID}_repos` (a volume name), and compose cannot transform a value between the
 * two conventions. So an id containing `-` would have to be folded for volumes — which code can do
 * and compose cannot, leaving the two halves of one install naming different volumes. Forbidding
 * the character is the only way both layers can agree from a single variable.
 *
 * Lower case only, because Postgres folds an unquoted identifier and two ids would name one
 * database.
 */
const INSTALL_ID_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;

export class InvalidInstallIdError extends Error {
  constructor(value: string) {
    super(
      `HAIVE_INSTALL_ID must be 1-32 characters of [a-z0-9_] starting with a letter or digit, and ` +
        `was ${JSON.stringify(value)}. No '-': compose interpolates this id into both container ` +
        `names ("<id>-api") and volume names ("<id>_repos") and cannot convert between them, so a ` +
        `separator inside the id would make those two halves disagree.`,
    );
    this.name = 'InvalidInstallIdError';
  }
}

/**
 * This install's id.
 *
 * Read from the environment on every call rather than cached: a cached value would have to be
 * invalidated for tests, and the read is a property lookup against a name used at
 * container-creation frequency, never in a hot loop.
 */
export function installId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HAIVE_INSTALL_ID;
  if (raw === undefined || raw === '') return DEFAULT_INSTALL_ID;
  const id = raw.trim();
  if (!INSTALL_ID_PATTERN.test(id)) throw new InvalidInstallIdError(raw);
  return id;
}

/** Docker containers, networks and image repositories use `-`. */
export function dashPrefix(env?: NodeJS.ProcessEnv): string {
  return `${installId(env)}-`;
}

/** Docker volumes and Postgres databases use `_`. The id itself carries no separator (see
 *  INSTALL_ID_PATTERN), so this differs from `dashPrefix` only in the character appended — which
 *  is exactly what lets compose build both forms from one variable. */
export function underscorePrefix(env?: NodeJS.ProcessEnv): string {
  return `${installId(env)}_`;
}

/* ── Containers ──────────────────────────────────────────────────────────── */

/** Container families this install creates at runtime. Named here so a reaper's filter and the
 *  constructor it must match are the same string, resolved once. */
export const CONTAINER_FAMILY = {
  /** Per-invocation agent sandbox. */
  cli: 'cli',
  /** Interactive terminal session. */
  shell: 'shell',
  /** DDEV runtime runner for a task. */
  ddev: 'ddev',
  /** code-server IDE for a task. */
  ide: 'ide',
  /** One-shot CLI login container. */
  login: 'login',
  /** Egress gateway / squid sidecars. */
  egress: 'egress',
  squid: 'squid',
  /** Plain application runner (no DDEV). */
  app: 'app',
  /** The one-shot updater, which is deliberately NOT part of the compose project. */
  upgrade: 'upgrade',
} as const;
export type ContainerFamily = (typeof CONTAINER_FAMILY)[keyof typeof CONTAINER_FAMILY];

/** `haive-cli-<parts…>` at the default id. */
export function containerName(family: ContainerFamily, ...parts: (string | number)[]): string {
  const suffix = parts.length > 0 ? `-${parts.join('-')}` : '';
  return `${dashPrefix()}${family}${suffix}`;
}

/** The prefix a `docker ps --filter name=` sweep must use for that family. Anchored by the caller
 *  with `^` where docker supports it; returned unanchored because it is also used for
 *  `String.startsWith`. */
export function containerPrefix(family: ContainerFamily): string {
  return `${dashPrefix()}${family}-`;
}

/** True when a container name belongs to this install's family. */
export function isContainerOf(family: ContainerFamily, name: string): boolean {
  return name.startsWith(containerPrefix(family));
}

/**
 * A container declared in `docker-compose.yml` — `haive-api`, `haive-ollama`, `haive-postgres`.
 *
 * Compose builds these from the same install id (`container_name: ${HAIVE_INSTALL_ID:-haive}-api`),
 * so code that recognises one BY NAME has to build it the same way. `IN_STACK_OLLAMA_HOSTS` is the
 * live example: it decides whether an Ollama URL points at this stack's own daemon, and a literal
 * `haive-ollama` there stops recognising a second install's — which reads as "external endpoint"
 * and changes how the run is priced and routed.
 */
export function composeContainerName(service: string): string {
  return `${dashPrefix()}${service}`;
}

/** Every container this install owns, whatever its family — for a whole-install sweep. */
export function installContainerPrefix(): string {
  return dashPrefix();
}

/* ── Volumes ─────────────────────────────────────────────────────────────── */

/** Volumes declared in `docker-compose.yml` with an explicit global `name:`. These are the five
 *  that SHARE silently between installs, which is the reason this module exists. */
export const SHARED_VOLUME = {
  repos: 'repos',
  bundles: 'bundles',
  wrappers: 'wrappers',
  squidConfigs: 'squid_configs',
  ddevCa: 'ddev_ca',
  npmCache: 'npm_cache',
  ddevRegistryCache: 'ddev_registry_cache',
} as const;
export type SharedVolume = (typeof SHARED_VOLUME)[keyof typeof SHARED_VOLUME];

/** `haive_repos` at the default id. */
export function volumeName(...parts: (string | number)[]): string {
  return `${underscorePrefix()}${parts.join('_')}`;
}

/** Prefix for a family of runtime-created volumes (`cli_auth`, `ide_ext`, …). */
export function volumePrefix(family: string): string {
  return `${underscorePrefix()}${family}_`;
}

export function isVolumeOf(family: string, name: string): boolean {
  return name.startsWith(volumePrefix(family));
}

/* ── Networks and images ─────────────────────────────────────────────────── */

/** `haive-network`, `haive-sandbox`, `haive-models`. */
export function networkName(suffix: string): string {
  return `${dashPrefix()}${suffix}`;
}

/** Image REPOSITORY (no tag): `haive-cli-sandbox`, `haive-sandbox`, `haive-ddev-runner`. Two
 *  installs building the same content would otherwise overwrite one tag, and one install's image
 *  reaper would delete the other's cached layers by name. */
export function imageRepo(suffix: string): string {
  return `${dashPrefix()}${suffix}`;
}

/* ── Postgres databases ──────────────────────────────────────────────────── */

/** `haive_rag_<project>` / `haive_kb_global`. Underscore form, so the identifier needs no
 *  quoting and Postgres' lower-case folding cannot change it. */
export function databaseName(...parts: string[]): string {
  return `${underscorePrefix()}${parts.join('_')}`;
}

export function databasePrefix(family: string): string {
  return `${underscorePrefix()}${family}_`;
}

/* ── Docker labels ───────────────────────────────────────────────────────── */

/**
 * The label that says which install owns a container.
 *
 * Names alone are NOT enough, and this is the half that bites. Most reapers select by LABEL, not
 * by name — `reapAllCliSandboxes` sweeps `label=haive.task.id` on every worker boot, preemption
 * keys on `haive.invocation.id`, the runtime reaper on `haive.ddev` — and those keys are identical
 * in every install. So a second install's worker booting would force-remove the first install's
 * running agent sandboxes, whatever they are called.
 */
export const INSTALL_LABEL = 'haive.install';

/** `haive.install=<id>`, for `docker run --label`. */
export function installLabel(env?: NodeJS.ProcessEnv): string {
  return `${INSTALL_LABEL}=${installId(env)}`;
}

/**
 * Does a resource carrying this label value belong to THIS install?
 *
 * The `undefined` case is the compatibility hinge and is deliberately asymmetric. A container
 * created before this label existed carries none, and it belongs to the install that was running
 * then — which is by definition the default one. So:
 *
 * - the DEFAULT install claims unlabelled resources, or its reapers would stop recognising every
 *   container and volume already on the host and leak them forever with nothing reporting it;
 * - a NON-DEFAULT install never claims them, because an unlabelled resource is someone else's.
 *
 * Expressed in code rather than as a `docker ps --filter`, because a filter cannot say "this value
 * OR absent" — which is exactly why the label has to be read out with `--format` and tested here.
 */
export function ownsLabelValue(value: string | null | undefined): boolean {
  const id = installId();
  if (value === undefined || value === null || value === '') return id === DEFAULT_INSTALL_ID;
  return value === id;
}
