import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { resolveIdeWorkspaceSubpath } from './ide-runner.js';

// The default global code-server settings.json seeded into a new user-data volume.
// Minimal and uncontroversial: telemetry off (code-server already has --disable-
// telemetry, this is belt-and-suspenders for the workbench). Slice 6 replaces this
// with the user's DB-backed settings, edited from the settings page.
const DEFAULT_IDE_SETTINGS = JSON.stringify(
  {
    'telemetry.telemetryLevel': 'off',
  },
  null,
  2,
);

/** The debug launch configs seeded for a debug-mode task — one per lane:
 *  - Listen for Xdebug (PHP): php-debug LISTENS on 9003; PHP (under DDEV) connects IN
 *    via the runner's socat forward. hostname 0.0.0.0 so the listener accepts the
 *    IPv4 connection. pathMappings /var/www/html (DDEV project root) -> /workspace,
 *    the SAME bytes (the haive_repos worktree subpath), so breakpoints bind.
 *  - Attach to Chrome (VNC): js-debug attaches to the runner's CDP at localhost:9223
 *    (the IDE-side forward bridges localhost -> runner). webRoot maps served assets.
 *  - Attach to Node (DDEV / app-runner): js-debug attaches to a node --inspect at
 *    localhost:9229 (IDE-side forward -> runner -> node). remoteRoot differs by
 *    runtime: DDEV mounts the project at /var/www/html; the app-runner runs it from
 *    /repos/<subpath> (resolved per task). Two configs so the user picks their lane.
 *  The built-in js-debug serves chrome + node; only php-debug is installed extra. */
function buildDebugConfigs(appRunnerRemoteRoot: string | null): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = [
    {
      name: 'Listen for Xdebug (Haive)',
      type: 'php',
      request: 'launch',
      port: 9003,
      hostname: '0.0.0.0',
      pathMappings: { '/var/www/html': '/workspace' },
    },
    {
      name: 'Attach to Chrome — VNC browser (Haive)',
      type: 'chrome',
      request: 'attach',
      port: 9223,
      webRoot: '/workspace',
    },
    {
      name: 'Attach to Node — DDEV (Haive)',
      type: 'node',
      request: 'attach',
      address: 'localhost',
      port: 9229,
      localRoot: '/workspace',
      remoteRoot: '/var/www/html',
      skipFiles: ['<node_internals>/**'],
    },
  ];
  if (appRunnerRemoteRoot) {
    configs.push({
      name: 'Attach to Node — app-runner (Haive)',
      type: 'node',
      request: 'attach',
      address: 'localhost',
      port: 9229,
      localRoot: '/workspace',
      remoteRoot: appRunnerRemoteRoot,
      skipFiles: ['<node_internals>/**'],
    });
  }
  return configs;
}

/** Merge the Haive debug launch configurations into a settings object. VS Code /
 *  code-server reads a global `launch` key from user settings.json when the
 *  workspace has no .vscode/launch.json — so debugging works without writing any
 *  file into the user's repo. Adds each config only when absent by name (never
 *  clobbers a user-defined block); appends to an existing configurations array. */
function withDebugLaunch(
  settings: Record<string, unknown>,
  appRunnerRemoteRoot: string | null,
): Record<string, unknown> {
  const launch = (settings.launch as Record<string, unknown> | undefined) ?? {};
  const configs = Array.isArray(launch.configurations) ? [...launch.configurations] : [];
  const names = new Set(configs.map((c) => (c as { name?: string } | null)?.name).filter(Boolean));
  for (const cfg of buildDebugConfigs(appRunnerRemoteRoot)) {
    if (!names.has(cfg.name as string)) configs.push(cfg);
  }
  return {
    ...settings,
    launch: { version: '0.2.0', ...launch, configurations: configs },
  };
}

/** Resolve a user's global code-server settings.json (a JSON string), seeded into
 *  the IDE user-data volume at launch. Reads the per-user DB store (edited from the
 *  settings page); falls back to the minimal default when the user has no row. When
 *  `taskId` is supplied and that task opted into debug mode, a "Listen for Xdebug"
 *  launch config is merged in (best-effort: a malformed user settings string is
 *  passed through unchanged rather than failing the IDE launch). */
export async function resolveIdeSettingsJson(
  db: Database,
  userId: string,
  taskId?: string,
): Promise<string> {
  const row = await db.query.userIdeSettings.findFirst({
    where: eq(schema.userIdeSettings.userId, userId),
    columns: { settingsJson: true },
  });
  const base = row?.settingsJson ?? DEFAULT_IDE_SETTINGS;

  if (!taskId) return base;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { debugMode: true },
  });
  if (!task?.debugMode) return base;

  // The app-runner runs the app from /repos/<subpath> (the worktree), so the node
  // attach config for that lane needs that as remoteRoot. Null when there's no
  // volume-backed worktree (the IDE wouldn't start anyway) — then that config is
  // omitted and only the DDEV node config is offered.
  const subpath = await resolveIdeWorkspaceSubpath(db, taskId).catch(() => null);
  const appRunnerRemoteRoot = subpath ? `/repos/${subpath}` : null;

  try {
    const parsed = JSON.parse(base) as Record<string, unknown>;
    return JSON.stringify(withDebugLaunch(parsed, appRunnerRemoteRoot), null, 2);
  } catch {
    // User settings string isn't valid JSON — don't break the launch over it.
    return base;
  }
}
