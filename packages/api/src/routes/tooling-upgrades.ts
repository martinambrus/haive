import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { DEFAULT_RTK_VERSION, TOOL_INSTALL_METADATA, type ToolName } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

export const toolingUpgradeRoutes = new Hono<AppEnv>();
toolingUpgradeRoutes.use('*', requireAuth);

/** Per-repo tooling component (RTK, chrome-devtools-mcp, an LSP server). */
interface ToolingComponentStatus {
  /** Stable component id: 'rtk', 'chrome-devtools-mcp', or an lsp key (which may
   *  be 'intelephense-extended' even though its package/tool is 'intelephense'). */
  component: string;
  displayName: string;
  installed: string | null;
  latest: string | null;
  upgradeAvailable: boolean;
}

interface ToolingUpgradeStatusResponse {
  repositoryId: string;
  hasUpgradeAvailable: boolean;
  components: ToolingComponentStatus[];
}

// lsp key (as stored in declaredDeps.lspServers / repo.lspServerVersions) -> the
// tool name whose version cache + package it maps to. intelephense-extended is
// the same intelephense package.
const LSP_KEY_TO_TOOL: Record<string, ToolName> = {
  intelephense: 'intelephense',
  'intelephense-extended': 'intelephense',
  vtsls: 'vtsls',
  pyright: 'pyright',
  gopls: 'gopls',
  solargraph: 'solargraph',
  'rust-analyzer': 'rust-analyzer',
  jdtls: 'jdtls',
};

/** Selectable LSP servers (env keys) for the per-repo tooling management page. */
const LSP_SERVER_OPTIONS: { value: string; label: string }[] = [
  { value: 'intelephense', label: 'Intelephense (PHP)' },
  { value: 'intelephense-extended', label: 'Intelephense + CMS extensions (PHP)' },
  { value: 'vtsls', label: 'vtsls (TypeScript / JavaScript)' },
  { value: 'pyright', label: 'Pyright (Python)' },
  { value: 'gopls', label: 'gopls (Go)' },
  { value: 'rust-analyzer', label: 'rust-analyzer (Rust)' },
  { value: 'solargraph', label: 'Solargraph (Ruby)' },
  { value: 'jdtls', label: 'jdtls (Java)' },
];
const LSP_KEY_SET = new Set(LSP_SERVER_OPTIONS.map((o) => o.value));

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is a strictly newer release than `current`. Unparseable
 *  versions never flag an upgrade (so we never prompt a churn/downgrade we can't
 *  reason about). */
function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

async function loadToolVersions(
  db: ReturnType<typeof getDb>,
): Promise<Map<string, { versions: string[]; latest: string | null }>> {
  const rows = await db
    .select({
      name: schema.toolPackageVersions.name,
      versions: schema.toolPackageVersions.versions,
      latestVersion: schema.toolPackageVersions.latestVersion,
    })
    .from(schema.toolPackageVersions);
  const map = new Map<string, { versions: string[]; latest: string | null }>();
  for (const r of rows)
    map.set(r.name, { versions: r.versions ?? [], latest: r.latestVersion ?? null });
  return map;
}

/** Newest installable version for a tool: the head of the sorted-desc versions
 *  list (the highest published), falling back to the dist-tag latest. The list
 *  head is preferred because the dist-tag can lag behind the newest publish. */
function newestFor(
  tool: ToolName,
  versionMap: Map<string, { versions: string[]; latest: string | null }>,
): string | null {
  const entry = versionMap.get(tool);
  if (!entry) return null;
  return entry.versions[0] ?? entry.latest ?? null;
}

/** Build the candidate component list from the repo's pins. RTK is always
 *  present (an unpinned repo runs the baked default, which is genuinely stale);
 *  LSP/chrome appear only when explicitly pinned, since unpinned means
 *  latest-at-build (no upgrade notion). */
function repoComponents(repo: {
  rtkVersion: string | null;
  lspServerVersions: Record<string, string | null> | null;
  chromeDevtoolsMcpVersion: string | null;
}): { component: string; tool: ToolName; installed: string }[] {
  const out: { component: string; tool: ToolName; installed: string }[] = [];
  out.push({ component: 'rtk', tool: 'rtk', installed: repo.rtkVersion ?? DEFAULT_RTK_VERSION });
  for (const [lspKey, version] of Object.entries(repo.lspServerVersions ?? {})) {
    const tool = LSP_KEY_TO_TOOL[lspKey];
    if (!tool || !version || !TOOL_INSTALL_METADATA[tool].versionPinnable) continue;
    out.push({ component: lspKey, tool, installed: version });
  }
  if (repo.chromeDevtoolsMcpVersion) {
    out.push({
      component: 'chrome-devtools-mcp',
      tool: 'chrome-devtools-mcp',
      installed: repo.chromeDevtoolsMcpVersion,
    });
  }
  return out;
}

toolingUpgradeRoutes.get('/:id/tooling-upgrade-status', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      rtkVersion: true,
      lspServerVersions: true,
      chromeDevtoolsMcpVersion: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const versionMap = await loadToolVersions(db);
  const components: ToolingComponentStatus[] = repoComponents(repo).map(
    ({ component, tool, installed }) => {
      const latest = newestFor(tool, versionMap);
      return {
        component,
        displayName: TOOL_INSTALL_METADATA[tool].displayName,
        installed,
        latest,
        upgradeAvailable: !!latest && isNewer(latest, installed),
      };
    },
  );

  const body: ToolingUpgradeStatusResponse = {
    repositoryId,
    hasUpgradeAvailable: components.some((x) => x.upgradeAvailable),
    components,
  };
  return c.json(body);
});

toolingUpgradeRoutes.post('/:id/tooling-upgrade', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      rtkVersion: true,
      lspServerVersions: true,
      chromeDevtoolsMcpVersion: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  // Optional { components: string[] } restricts which to upgrade; absent = all.
  let parsed: { components?: string[] } = {};
  try {
    parsed = (await c.req.json()) as { components?: string[] };
  } catch {
    // empty body → upgrade everything upgradeable
  }
  const requested = Array.isArray(parsed.components) ? new Set(parsed.components) : null;

  const versionMap = await loadToolVersions(db);
  const applied: { component: string; from: string; to: string }[] = [];
  let nextRtk = repo.rtkVersion;
  const nextLsp: Record<string, string | null> = { ...(repo.lspServerVersions ?? {}) };
  let nextChrome = repo.chromeDevtoolsMcpVersion;

  for (const { component, tool, installed } of repoComponents(repo)) {
    if (requested && !requested.has(component)) continue;
    const latest = newestFor(tool, versionMap);
    if (!latest || !isNewer(latest, installed)) continue;
    applied.push({ component, from: installed, to: latest });
    if (component === 'rtk') nextRtk = latest;
    else if (component === 'chrome-devtools-mcp') nextChrome = latest;
    else nextLsp[component] = latest;
  }

  // Only the repo pins change here. The repo's next workflow task re-runs
  // 01-declare-deps, which injects the new pins into declaredDeps → the
  // staleDockerfile check re-renders + rebuilds the env image (and the composed
  // image rebuilds on its hash change). No eager build is triggered.
  if (applied.length > 0) {
    await db
      .update(schema.repositories)
      .set({
        rtkVersion: nextRtk,
        lspServerVersions: nextLsp,
        chromeDevtoolsMcpVersion: nextChrome,
        updatedAt: new Date(),
      })
      .where(eq(schema.repositories.id, repositoryId));
  }

  return c.json({ repositoryId, applied, rebuildOnNextTask: applied.length > 0 });
});

/** Current per-repo tooling config + available versions, for the management page. */
toolingUpgradeRoutes.get('/:id/tooling-config', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      rtkEnabled: true,
      rtkVersion: true,
      lspServers: true,
      lspServerVersions: true,
      chromeDevtoolsMcpVersion: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  // Effective active LSP set + browser-testing flag from the repo's latest
  // env-template when there is no explicit repo-level LSP override.
  const envTemplate = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.repositoryId, repositoryId),
    orderBy: [desc(schema.envTemplates.updatedAt)],
    columns: { declaredDeps: true },
  });
  const deps = (envTemplate?.declaredDeps ?? {}) as {
    lspServers?: string[];
    browserTesting?: boolean;
  };

  const versionMap = await loadToolVersions(db);
  const versionsFor = (tool: ToolName): string[] => versionMap.get(tool)?.versions ?? [];

  const lspOptions = LSP_SERVER_OPTIONS.map((o) => {
    const tool = LSP_KEY_TO_TOOL[o.value]!;
    const meta = TOOL_INSTALL_METADATA[tool];
    return {
      value: o.value,
      label: o.label,
      pinnable: meta.versionPinnable,
      versions: meta.versionPinnable ? versionsFor(tool) : [],
    };
  });

  return c.json({
    repositoryId,
    rtkEnabled: repo.rtkEnabled,
    rtkVersion: repo.rtkVersion,
    rtkVersions: versionsFor('rtk'),
    chromeDevtoolsMcpVersion: repo.chromeDevtoolsMcpVersion,
    chromeVersions: versionsFor('chrome-devtools-mcp'),
    browserTesting: !!deps.browserTesting,
    lspServers: repo.lspServers ?? deps.lspServers ?? [],
    lspServerVersions: repo.lspServerVersions ?? {},
    lspOptions,
  });
});

/** Update per-repo tooling: enable/disable RTK + LSP servers and pin versions.
 *  Only writes repo columns; the env image rebuilds on the next task (via
 *  01-declare-deps re-injection). Disabling RTK flips rtk_enabled — the
 *  .claude/settings.json hook is then reconciled by the existing onboarding
 *  upgrade flow (the workflow upgrade banner surfaces rtk-config as removable). */
toolingUpgradeRoutes.patch('/:id/tooling', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const body = (await c.req.json().catch(() => ({}))) as {
    rtkEnabled?: boolean;
    rtkVersion?: string | null;
    lspServers?: string[];
    lspServerVersions?: Record<string, string | null>;
    chromeDevtoolsMcpVersion?: string | null;
  };

  const updates: Partial<typeof schema.repositories.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.rtkEnabled === 'boolean') updates.rtkEnabled = body.rtkEnabled;
  if (body.rtkVersion !== undefined) updates.rtkVersion = body.rtkVersion?.trim() || null;
  if (body.chromeDevtoolsMcpVersion !== undefined) {
    updates.chromeDevtoolsMcpVersion = body.chromeDevtoolsMcpVersion?.trim() || null;
  }
  if (Array.isArray(body.lspServers)) {
    updates.lspServers = [...new Set(body.lspServers.filter((s) => LSP_KEY_SET.has(s)))];
  }
  if (body.lspServerVersions && typeof body.lspServerVersions === 'object') {
    const clean: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(body.lspServerVersions)) {
      if (!LSP_KEY_SET.has(k)) continue;
      const val = typeof v === 'string' ? v.trim() : '';
      if (val) clean[k] = val;
    }
    updates.lspServerVersions = clean;
  }

  await db.update(schema.repositories).set(updates).where(eq(schema.repositories.id, repositoryId));
  return c.json({ repositoryId, ok: true });
});
