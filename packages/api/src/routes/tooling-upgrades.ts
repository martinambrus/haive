import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
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
