import { Hono } from 'hono';
import { z } from 'zod';
import { schema } from '@haive/database';
import {
  configService,
  MODULE_CONTROL_JOB_NAMES,
  validateFormValues,
  type ModuleTeardownPayload,
  type ModuleTeardownResult,
} from '@haive/shared';
import {
  collectFieldIds,
  diffModuleIntent,
  MODULES_LOADED_WORKER_KEY,
  moduleManifestSchema,
  type ModuleManifest,
} from '@haive/shared/modularity';
import {
  moduleSettingKey,
  type ModuleRouteContext,
  type ModuleSettingsKind,
} from '@haive/shared/module-host';
import { HttpError, type AppEnv } from '../context.js';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { getModuleControlQueue, getModuleControlQueueEvents } from '../queues.js';
import { getRedis } from '../redis.js';
import {
  deactivatedModuleIds,
  isModuleDeactivated,
  liveDependents,
  setModuleActive,
} from './activation.js';
import { PurgeIncompleteError, purgeModule } from './purge.js';

export type ApiModuleEntry = {
  packageName: string;
  manifest: unknown;
  routes?: (ctx: ModuleRouteContext) => Hono<AppEnv>;
};

export type LoadedApiModule = {
  packageName: string;
  manifest: ModuleManifest;
  hasRoutes: boolean;
};

const putBodySchema = z.object({ values: z.record(z.string(), z.unknown()) });
const patchBodySchema = z.object({ active: z.boolean() }).strict();
const purgeBodySchema = z.object({ confirm: z.string() });
const TEARDOWN_WAIT_MS = 120_000;

function settingsOf(manifest: ModuleManifest, kind: ModuleSettingsKind) {
  return kind === 'global' ? manifest.globalSettings : manifest.adminSettings;
}

function parseKind(raw: string): ModuleSettingsKind {
  if (raw === 'global' || raw === 'admin') return raw;
  throw new HttpError(404, 'Unknown settings kind');
}

export async function mountModules(
  app: Hono<AppEnv>,
  entries: readonly ApiModuleEntry[],
  ctx: ModuleRouteContext,
): Promise<LoadedApiModule[]> {
  const loaded: LoadedApiModule[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = moduleManifestSchema.safeParse(entry.manifest);
    if (!parsed.success) {
      throw new Error(
        `Invalid manifest in module ${entry.packageName}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const manifest = parsed.data;
    if (entry.packageName !== `@haive/module-${manifest.id}`) {
      throw new Error(
        `Module ${entry.packageName} declares id "${manifest.id}"; its package must be named @haive/module-${manifest.id}`,
      );
    }
    if (seen.has(manifest.id)) {
      throw new Error(`Duplicate module id "${manifest.id}" (${entry.packageName})`);
    }
    seen.add(manifest.id);
    loaded.push({
      packageName: entry.packageName,
      manifest,
      hasRoutes: entry.routes !== undefined,
    });
  }

  for (const [index, entry] of entries.entries()) {
    const { manifest } = loaded[index]!;
    if (entry.routes) {
      const sub = new Hono<AppEnv>();
      sub.use('*', requireAuth);
      sub.use('*', async (c, next) => {
        if (await isModuleDeactivated(ctx.db, manifest.id)) return c.notFound();
        await next();
      });
      if (manifest.apiRequiresAdmin === true) sub.use('*', requireAdmin);
      sub.route('/', entry.routes(ctx));
      app.route(`/m/${manifest.id}`, sub);
    }
    for (const kind of ['global', 'admin'] as const) {
      const defaults = settingsOf(manifest, kind)?.defaults ?? {};
      for (const [field, value] of Object.entries(defaults)) {
        await configService.setIfAbsent(
          moduleSettingKey(manifest.id, kind, field),
          JSON.stringify(value),
        );
      }
    }
  }
  return loaded;
}

export function moduleRoutes(loaded: readonly LoadedApiModule[]): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAuth);

  const settingsFor = async (id: string, kind: ModuleSettingsKind) => {
    const module = loaded.find((m) => m.manifest.id === id);
    const settings = module ? settingsOf(module.manifest, kind) : undefined;
    if (!module || !settings || (await isModuleDeactivated(getDb(), id))) {
      throw new HttpError(404, 'Module settings not found');
    }
    return settings;
  };

  routes.get('/', async (c) => {
    const isAdmin = c.get('userRole') === 'admin';
    const off = await deactivatedModuleIds(getDb());
    const active = loaded.filter(({ manifest }) => !off.has(manifest.id));
    return c.json({
      modules: active.map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        nav: (manifest.nav ?? []).filter((item) => isAdmin || item.adminOnly !== true),
        pages:
          isAdmin || manifest.apiRequiresAdmin !== true
            ? (manifest.pages ?? {})
            : Object.fromEntries(
                Object.entries(manifest.pages ?? {}).filter(([, page]) =>
                  page.widgets.every((w) => !('endpoint' in w) || w.endpoint === undefined),
                ),
              ),
        hasGlobalSettings: manifest.globalSettings !== undefined,
        hasAdminSettings: isAdmin && manifest.adminSettings !== undefined,
        // Compiled pages and widgets call the module's api, and an admin-only one refuses a user.
        compiledWeb: isAdmin || manifest.apiRequiresAdmin !== true,
      })),
    });
  });

  const loadedReport = async () => {
    let worker: unknown = null;
    const raw = await getRedis().get(MODULES_LOADED_WORKER_KEY);
    if (raw !== null) {
      try {
        worker = JSON.parse(raw);
      } catch {
        worker = null;
      }
    }
    const apiModules = loaded.map(({ packageName, manifest, hasRoutes }) => ({
      id: manifest.id,
      packageName,
      version: manifest.version,
      hasRoutes,
    }));
    const intent = await getDb().select().from(schema.modules);
    return {
      api: { modules: apiModules },
      worker,
      intent,
      modules: diffModuleIntent(intent, apiModules, worker),
    };
  };

  routes.get('/loaded', async (c) => {
    if (c.get('userRole') !== 'admin') throw new HttpError(403, 'Admin access required');
    return c.json(await loadedReport());
  });

  routes.patch('/:id', requireAdmin, async (c) => {
    const id = c.req.param('id');
    const { active } = patchBodySchema.parse(await c.req.json());
    const db = getDb();
    const result = await setModuleActive(db, id, active);
    if (result.kind === 'missing') throw new HttpError(404, 'Module not found');
    if (result.kind === 'open') {
      return c.json(
        {
          error: 'Live tasks still use this module. Finish or cancel them first.',
          code: 'module_tasks_open',
          tasks: result.tasks,
        },
        409,
      );
    }
    await recordAuditEvent(db, {
      actorUserId: c.get('userId'),
      action: active ? 'module.activate' : 'module.deactivate',
      targetType: 'module',
      targetId: null,
      metadata: { moduleId: id },
    });
    return c.json({
      moduleId: id,
      active,
      deactivatedAt: result.deactivatedAt?.toISOString() ?? null,
    });
  });

  routes.post('/:id/teardown', requireAdmin, async (c) => {
    const id = c.req.param('id');
    const row = (await loadedReport()).modules.rows.find((r) => r.id === id);
    if (row === undefined || row.rowVersion === null) throw new HttpError(404, 'Module not found');
    if (row.deactivatedAt === null) {
      throw new HttpError(409, 'Deactivate the module before tearing it down', 'module_active');
    }
    if (row.state !== 'loaded') {
      throw new HttpError(
        409,
        'The api and the worker must both have loaded the module to tear it down',
        'module_missing',
      );
    }
    const job = await getModuleControlQueue().add(
      MODULE_CONTROL_JOB_NAMES.TEARDOWN,
      { moduleId: id } satisfies ModuleTeardownPayload,
      { deduplication: { id: `module-teardown-${id}` }, removeOnComplete: 100, removeOnFail: 100 },
    );
    await recordAuditEvent(getDb(), {
      actorUserId: c.get('userId'),
      action: 'module.teardown',
      targetType: 'module',
      targetId: null,
      metadata: { moduleId: id },
    });
    let result: ModuleTeardownResult;
    try {
      result = (await job.waitUntilFinished(
        getModuleControlQueueEvents(),
        TEARDOWN_WAIT_MS,
      )) as ModuleTeardownResult;
    } catch (err) {
      const state = await job.getState().catch(() => 'unknown');
      if (state !== 'failed') return c.json({ status: 'running' }, 202);
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          code: 'module_teardown_failed',
        },
        502,
      );
    }
    if (result.tornDownAt === null) {
      return c.json(
        {
          error: `Module ${id} was activated again while its teardown ran; nothing was recorded`,
          code: 'module_active',
        },
        409,
      );
    }
    return c.json({ moduleId: id, tornDownAt: result.tornDownAt });
  });

  routes.post('/:id/purge', requireAdmin, async (c) => {
    const id = c.req.param('id');
    const body = purgeBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success || body.data.confirm !== id) {
      throw new HttpError(400, 'Type the module id to confirm the purge', 'confirm_mismatch');
    }
    const { modules } = await loadedReport();
    const row = modules.rows.find((r) => r.id === id);
    if (row === undefined || row.rowVersion === null) throw new HttpError(404, 'Module not found');
    if (row.missingAt === null) {
      throw new HttpError(409, 'Only a module that is missing can be purged', 'module_not_missing');
    }
    if (modules.workerAt === null) {
      throw new HttpError(
        409,
        'The worker has not reported what it loaded, so the module is not known to be gone',
        'worker_unreported',
      );
    }
    if (row.apiVersion !== null || row.workerVersion !== null) {
      throw new HttpError(409, 'The api or the worker still loads this module', 'module_loaded');
    }
    const db = getDb();
    const tasks = await liveDependents(db, id, true);
    if (tasks.length > 0) {
      return c.json(
        {
          error: 'Live tasks still use this module, dead ones included. Cancel them first.',
          code: 'module_tasks_open',
          tasks,
        },
        409,
      );
    }
    const result = await purgeModule(db, getRedis(), id).catch((err: unknown) => {
      if (!(err instanceof PurgeIncompleteError)) throw err;
      throw new HttpError(
        502,
        'The module database was dropped, but removing its settings, task types and row failed. Run the purge again to finish it.',
        'module_purge_incomplete',
      );
    });
    if (result.kind === 'in-use') {
      throw new HttpError(
        409,
        'Another connection still holds the module database. Nothing was removed.',
        'module_database_in_use',
      );
    }
    if (result.kind === 'gone') throw new HttpError(404, 'Module not found');
    await recordAuditEvent(db, {
      actorUserId: c.get('userId'),
      action: 'module.purge',
      targetType: 'module',
      targetId: null,
      metadata: {
        moduleId: id,
        database: result.database,
        configKeysDeleted: result.configKeysDeleted,
        taskTypesDeleted: result.taskTypesDeleted,
        taskTypesKept: result.taskTypesKept,
      },
    });
    if (result.kind === 'came-back') {
      throw new HttpError(
        409,
        'The module loaded again while it was purged. Its database and settings are gone and its row and task types were kept: restart the worker to create the database again.',
        'module_came_back',
      );
    }
    return c.json({
      moduleId: id,
      database: result.database,
      configKeysDeleted: result.configKeysDeleted,
      taskTypesDeleted: result.taskTypesDeleted,
      taskTypesKept: result.taskTypesKept,
    });
  });

  routes.get('/:id/settings/:kind', async (c) => {
    const id = c.req.param('id');
    const kind = parseKind(c.req.param('kind'));
    const settings = await settingsFor(id, kind);
    if (kind === 'admin' && c.get('userRole') !== 'admin') {
      throw new HttpError(403, 'Admin access required');
    }
    const values: Record<string, unknown> = { ...settings.defaults };
    for (const field of new Set([
      ...Object.keys(settings.defaults),
      ...collectFieldIds(settings.form),
    ])) {
      const stored = await configService.getFresh(moduleSettingKey(id, kind, field));
      if (stored !== null) {
        try {
          values[field] = JSON.parse(stored);
        } catch {
          // A non-JSON value is treated as absent: the default stays.
        }
      }
    }
    return c.json({ form: settings.form, values });
  });

  routes.put('/:id/settings/:kind', async (c) => {
    if (c.get('userRole') !== 'admin') throw new HttpError(403, 'Admin access required');
    const id = c.req.param('id');
    const kind = parseKind(c.req.param('kind'));
    const settings = await settingsFor(id, kind);
    const body = putBodySchema.parse(await c.req.json());
    const result = validateFormValues(settings.form, body.values);
    if (!result.success) throw new HttpError(400, result.issues.join('; '));
    for (const [field, value] of Object.entries(result.data)) {
      await configService.set(moduleSettingKey(id, kind, field), JSON.stringify(value));
    }
    return c.json({ values: result.data });
  });

  return routes;
}

export async function installModules(app: Hono<AppEnv>): Promise<void> {
  // Loaded at boot only: the generated file exists after codegen, not on every path that imports this.
  const { moduleRegistry } = await import('../modules.generated.js');
  const loaded = await mountModules(app, moduleRegistry, { db: getDb() });
  app.route('/modules', moduleRoutes(loaded));
}
