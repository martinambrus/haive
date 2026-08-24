import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  type OnboardingToolingMirror,
  CONFIG_KEYS,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  configService,
  logger,
} from '@haive/shared';
import { signRagToken } from '@haive/shared/rag';

const log = logger.child({ module: 'mcp-surface' });

/** Which MCP servers an invocation gets, and the values needed to wire them.
 *
 *  ONE decision, TWO consumers: resolveMcpExtraFiles materializes it into config
 *  files/args at container start, and the dispatcher renders it into the prompt at
 *  enqueue. Same shape as the worktree-git boundary, and for the same reason — a
 *  prompt that names a server the mount never wires (or omits one it does) sends the
 *  agent looking for tools that are not there, or leaves it assuming it has none.
 *  Task 4ce9b4e1's reviewer reported "DDEV execution is prohibited here" while
 *  holding no ddev tools and no prompt line saying so. */
export interface McpSurface {
  /** Narrowed to rag_search alone: report-only steps that cannot act on a browser
   *  or a container. Retained on the surface so the prompt can say so positively
   *  rather than leaving the model to infer it from an absence. */
  ragOnly: boolean;
  rag: { enabled: boolean; apiUrl: string; token: string };
  chromeDevtools: { enabled: boolean; version: string | null };
  ddevControl: { enabled: boolean; apiUrl: string; token: string };
  /** The user's own servers from `.claude/mcp_settings.json`, verbatim. */
  userServers: Record<string, unknown>;
}

/** Resolve the MCP surface for one invocation.
 *
 *  Deliberately does NOT probe the runner's CDP endpoint. That probe
 *  (resolveRunnerBrowserCdpUrl) costs up to 3 attempts x 2s and only decides whether
 *  chrome-devtools attaches to the runner's visible browser or self-launches a
 *  headless one — never whether the server is present. Keeping it out means the
 *  dispatcher can resolve the surface without paying for it on every enqueue. */
export async function resolveMcpSurface(
  db: Database,
  taskId: string,
  ragOnly: boolean,
): Promise<McpSurface> {
  // chrome-devtools is gated on a ready envTemplate with browserTesting;
  // ddev-control on the task declaring ddev as its container tool.
  let chromeDevtools = false;
  let chromeVersion: string | null = null;
  let isDdevTask = false;

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (!ragOnly && task?.envTemplateId) {
    const envTemplate = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, task.envTemplateId),
      columns: { declaredDeps: true, status: true },
    });
    if (envTemplate && envTemplate.status === 'ready') {
      const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
      chromeDevtools = !!deps?.browserTesting;
      isDdevTask = deps?.containerTool === 'ddev';
      chromeVersion = (deps?.chromeDevtoolsMcpVersion as string | null | undefined) ?? null;
    }
  }

  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  const ddevEnabled =
    isDdevTask &&
    !!secret &&
    (await configService.getBoolean(CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED, true));

  return {
    ragOnly,
    rag: await resolveRagMcpConfig(db, taskId),
    chromeDevtools: { enabled: chromeDevtools, version: chromeVersion },
    ddevControl: {
      enabled: ddevEnabled,
      apiUrl:
        process.env.DDEV_API_INTERNAL_URL || process.env.RAG_API_INTERNAL_URL || 'http://api:3001',
      token: ddevEnabled ? signRagToken(taskId, secret as string) : '',
    },
    userServers: ragOnly ? {} : await loadUserMcpServers(db, taskId),
  };
}

/** Resolve whether the haive-rag MCP server should be wired for this task,
 *  and mint its task-scoped token. Gated on the step-04 ragMode (independent of
 *  the chrome-devtools/envTemplate path), so RAG retrieval is available to
 *  agents whenever the project has a populated index. */
async function resolveRagMcpConfig(
  db: Database,
  taskId: string,
): Promise<{ enabled: boolean; apiUrl: string; token: string }> {
  const disabled = { enabled: false, apiUrl: '', token: '' };
  const readRagMode = (output: unknown): string | undefined =>
    (output as { tooling?: { ragMode?: string } } | null)?.tooling?.ragMode;

  // ragMode from the task's OWN step-04 output, else the repo's most recent
  // onboarding step-04 output. Workflow tasks have no 04-tooling-infrastructure
  // step of their own, so without this fallback RAG retrieval would never be
  // wired for them even when onboarding configured it (mirrors the repo
  // fallback in loadUserMcpServers below).
  const ownStep = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  let ragMode = readRagMode(ownStep?.output);
  if (!ragMode) {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (task?.repositoryId) {
      // Prefer the repo-level onboarding mirror (survives a clone, where the
      // onboarding task's step outputs don't exist); fall back to the repo's
      // most recent onboarding 04-tooling output for legacy repos.
      const repo = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, task.repositoryId),
        columns: { onboardingTooling: true },
      });
      const mirror = repo?.onboardingTooling as OnboardingToolingMirror | null | undefined;
      if (mirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && mirror.tooling) {
        ragMode = readRagMode({ tooling: mirror.tooling });
      }
      if (!ragMode) {
        const rows = await db
          .select({ output: schema.taskSteps.output })
          .from(schema.taskSteps)
          .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
          .where(
            and(
              eq(schema.tasks.repositoryId, task.repositoryId),
              eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
            ),
          )
          .orderBy(desc(schema.taskSteps.createdAt))
          .limit(1);
        ragMode = readRagMode(rows[0]?.output);
      }
    }
  }
  if (!ragMode || ragMode === 'none') return disabled;

  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) {
    log.warn({ taskId }, 'CONFIG_ENCRYPTION_KEY unset; haive-rag MCP disabled');
    return disabled;
  }
  // Sandbox -> API base URL. Defaults to the compose service name; override via
  // RAG_API_INTERNAL_URL when the sandbox reaches the API by another route
  // (e.g. host.docker.internal). Under networkPolicy 'allowlist' this host must
  // be allowlisted; under 'none' the proxy cannot reach the API and rag_search
  // will report a request failure (agents then fall through to KB/LSP/GREP).
  const apiUrl = process.env.RAG_API_INTERNAL_URL || 'http://api:3001';
  return { enabled: true, apiUrl, token: signRagToken(taskId, secret) };
}

/** Load the user's custom MCP servers (the `mcpServers` object from the repo's
 *  `.claude/mcp_settings.json`) so they can be merged additively into the
 *  generated runtime config. Sourced from the step-04 tooling output — this
 *  task's own if present, else the repository's most recent onboarding run —
 *  which is the canonical record of what was written to mcp_settings.json. */
async function loadUserMcpServers(db: Database, taskId: string): Promise<Record<string, unknown>> {
  const parse = (output: unknown): Record<string, unknown> | null => {
    const raw = (output as { tooling?: { mcpSettingsJson?: string } } | null)?.tooling
      ?.mcpSettingsJson;
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
      const obj = JSON.parse(raw) as { mcpServers?: unknown };
      return obj && typeof obj.mcpServers === 'object' && obj.mcpServers
        ? (obj.mcpServers as Record<string, unknown>)
        : {};
    } catch {
      return null;
    }
  };

  const own = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  const fromOwn = parse(own?.output);
  if (fromOwn) return fromOwn;

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return {};

  // Prefer the repo-level onboarding mirror (survives a clone, where the
  // onboarding task's step outputs don't exist — the committed
  // .claude/mcp_settings.json file is NOT read back at runtime, this DB record
  // is the source); fall back to the repo's most recent onboarding 04-tooling
  // output for legacy repos.
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { onboardingTooling: true },
  });
  const mirror = repo?.onboardingTooling as OnboardingToolingMirror | null | undefined;
  if (mirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && mirror.tooling) {
    const fromMirror = parse({ tooling: mirror.tooling });
    if (fromMirror) return fromMirror;
  }

  const rows = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
    .where(
      and(
        eq(schema.tasks.repositoryId, task.repositoryId),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
      ),
    )
    .orderBy(desc(schema.taskSteps.createdAt))
    .limit(1);
  return parse(rows[0]?.output) ?? {};
}

export const MCP_SURFACE_MARKER = '<haive_mcp_surface>';

/** User servers the agent can actually call, i.e. those NOT shadowed by a Haive
 *  server of the same name. serversToJsonObject writes the user's entries first and
 *  lets Haive's overwrite them, so a repo that defines its own `chrome-devtools` in
 *  mcp_settings.json ends up running Haive's — listing the name under both headings
 *  would announce a server that is not there.
 *
 *  Keyed on what is ENABLED, not on a fixed reserved list: with Haive's
 *  chrome-devtools off, nothing overwrites the user's entry and it really is theirs.
 *  `filesystem` and `git` are always emitted by buildDefaultMcpServers, so they always
 *  shadow. */
function reachableUserServerNames(surface: McpSurface): string[] {
  const shadowed = new Set(['filesystem', 'git']);
  if (surface.rag.enabled) shadowed.add('haive-rag');
  if (surface.chromeDevtools.enabled) shadowed.add('chrome-devtools');
  if (surface.ddevControl.enabled) shadowed.add('ddev-control');
  return Object.keys(surface.userServers).filter((name) => !shadowed.has(name));
}

export function hasAnyMcpServer(surface: McpSurface): boolean {
  return (
    surface.rag.enabled ||
    surface.chromeDevtools.enabled ||
    surface.ddevControl.enabled ||
    reachableUserServerNames(surface).length > 0
  );
}

/** Tab discipline for the browser server. Every invocation of a task attaches to the SAME
 *  headed Chromium on the runner (resolvers.ts probes the runner once per invocation and
 *  passes the same `--browser-url` to all of them), and chrome-devtools-mcp selects
 *  `pages[0]` on first connect — so without this, N concurrent agents all drive ONE tab.
 *  Live today in two places: `08d-adversarial-qa` (2/4/6 adversaries, the only mining
 *  fan-out that keeps the full MCP surface) and `06c-dag-execute` (`dag_parallel` coders).
 *  The symptoms are silent — a navigate landing under another agent's snapshot, a
 *  `resize_page` applied to someone else's viewport.
 *
 *  Tab 0 is not a free tab either: `browser-probe-connect.js` and `browser-login.js` both
 *  reuse `pages[0]` and bring it to front so the VNC panel shows the app to the human.
 *
 *  `isolatedContext` is named as a prohibition rather than left unmentioned because it
 *  reads like the obvious way to get isolation: it creates a separate browser context,
 *  i.e. a fresh cookie jar, which discards the one deterministic app login `_app-auth.ts`
 *  performs for the whole task.
 *
 *  Deliberately says nothing about which tab is in FRONT. A background tab is not
 *  something this codebase has measured for screenshot fidelity, and screenshots are the
 *  Gate 2 evidence, so the tool default (foreground) stands.
 *
 *  Says `close_page` even though `closeExtraBrowserTabs` reaps at the step barrier: the
 *  reap only runs once every agent of the step has ended, so an agent that tidies up
 *  releases its renderer minutes earlier — and the reap exists for the agents that are
 *  KILLED before they can.
 *
 *  Says nothing about undoing a `resize_page`, deliberately, even though an un-restored
 *  one is what the human sees at Gate 2. An agent CANNOT undo it: `resize_page` takes a
 *  CONTENT size and there is no window-state tool, so asking for the screen size
 *  overshoots the display — and every agent's tab lives in the SAME window (measured: two
 *  tabs, one `windowId`), so restoring at the end of one agent's run resizes a sibling's
 *  viewport mid-screenshot. It is restored at the barrier and at Gate 2 bring-up instead;
 *  see docker/ddev-runner/browser-restore-window.js. */
const BROWSER_TAB_DISCIPLINE = [
  '  SHARED browser: sibling agents may be driving it right now, and every session starts pointed',
  "  at tab 0 — the human's view in the VNC panel. Make `new_page({url})` your FIRST browser call",
  '  and stay in that tab; navigating or resizing before it hits whatever tab someone else is on.',
  '  Never pass `isolatedContext` — a fresh cookie jar loses the app login this task already did.',
  '  `close_page` your tab when done; if it refuses as the last open tab, leave it.',
] as const;

/** Prompt contract paired with the MCP config the sandbox actually receives.
 *
 *  Names ONLY the servers an agent is meant to reach. `filesystem` and `git` are
 *  omitted on purpose: the git server points at a workdir whose `.git` is a masked
 *  zero-byte file in every worktree invocation, and the same prompt tells the agent
 *  not to run git — advertising it would send it at a tool built to fail.
 *
 *  The `ddev-control` line states the exec limit explicitly. Without it an agent
 *  plans around a `ddev exec` that does not exist and reports the shortfall as an
 *  unverified risk. */
export function mcpSurfacePrompt(surface: McpSurface): string {
  const lines: string[] = [MCP_SURFACE_MARKER, 'MCP tools wired into this run:'];

  if (surface.rag.enabled) {
    lines.push(
      "- `rag_search` (haive-rag): hybrid semantic + lexical search over this repo's indexed code,",
      '  its knowledge base, and the global cross-project KB.',
    );
  }
  if (surface.chromeDevtools.enabled) {
    lines.push(
      "- `chrome-devtools`: drives the running app's browser — navigate, snapshot, evaluate scripts,",
      '  read console and network. Use it to VERIFY runtime behavior rather than reasoning about it.',
      ...BROWSER_TAB_DISCIPLINE,
    );
  }
  if (surface.ddevControl.enabled) {
    lines.push(
      "- `ddev-control`: `ddev_status`, `ddev_logs`, `ddev_restart` for THIS task's DDEV environment.",
      '  Status, logs and restart ONLY — it cannot run arbitrary commands, so there is no `ddev exec`',
      '  and no way to run tests, a linter or a syntax check inside the container from here.',
    );
  }
  const userNames = reachableUserServerNames(surface);
  if (userNames.length > 0) {
    lines.push(`- Project-configured servers: ${userNames.map((n) => `\`${n}\``).join(', ')}.`);
  }

  if (!surface.chromeDevtools.enabled && !surface.ddevControl.enabled) {
    lines.push(
      '',
      'No browser and no container tooling are wired into this run. That is deliberate, not a',
      'misconfiguration: this step works from the source as written. Do not plan verification that',
      'needs to execute the app, and state anything that would require running it as out of scope',
      'rather than as a finding against the change.',
    );
  }

  lines.push('</haive_mcp_surface>');
  return lines.join('\n');
}

/** Prepend the contract once. The marker makes this safe when nested prompt
 * builders or retry paths apply the same surface more than once. `null` means the
 * resolved CLI gets no MCP config at all (amp) — nothing to advertise.
 *
 * A surface with no servers at all also gets nothing. The block exists to describe a
 * toolset; with an empty one there is no list to give and no runtime limit worth
 * spending prompt on, so every such dispatch would carry a paragraph about tools that
 * were never on the table. */
export function withMcpSurface(prompt: string, surface: McpSurface | null): string {
  if (!surface || !hasAnyMcpServer(surface) || prompt.includes(MCP_SURFACE_MARKER)) return prompt;
  return `${mcpSurfacePrompt(surface)}\n\n${prompt}`;
}
