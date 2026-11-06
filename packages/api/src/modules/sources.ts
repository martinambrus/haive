import { asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { isLockNotAvailable, isUniqueViolationOf, schema } from '@haive/database';
import { MODULE_SOURCE_JOB_NAMES, secretsService } from '@haive/shared';
import { isBranchName } from '@haive/shared/git-args';
import { MODULE_ID_PATTERN } from '@haive/shared/modularity';
import { HttpError, type AppEnv } from '../context.js';
import { getDb } from '../db.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../lib/audit.js';
import { requireAdmin } from '../middleware/auth.js';
import { isUuid } from '../lib/uuid.js';
import { getModuleSourceQueue } from '../queues.js';

const registryPrefix = '@haive-module/';
const moduleId = z.string().refine((value) => MODULE_ID_PATTERN.test(value));
const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(
  '^' +
    numeric +
    '\\.' +
    numeric +
    '\\.' +
    numeric +
    '(?:-' +
    prerelease +
    '(?:\\.' +
    prerelease +
    ')*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
const tokenFields = {
  token: z.string().max(16384).optional(),
  clearToken: z.boolean().optional(),
};
const sourceBody = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('git'),
        moduleId,
        url: z
          .string()
          .max(2048)
          .refine((value) => {
            try {
              const url = new URL(value);
              const authority = value.slice(8).split('/')[0]!;
              return (
                value.startsWith('https://') &&
                url.protocol === 'https:' &&
                authority.length > 0 &&
                !!url.hostname &&
                !url.username &&
                !url.password &&
                !/[?#\s\\]/.test(value) &&
                !authority.includes('@')
              );
            } catch {
              return false;
            }
          }, 'Use an HTTPS URL without userinfo, query or fragment')
          .transform((value) => new URL(value).href),
        ref: z
          .string()
          .min(1)
          .max(256)
          .refine(
            (value) =>
              isBranchName(value) &&
              !value.startsWith('+') &&
              !value.startsWith('refs/') &&
              !/\s/.test(value),
            'Use a bare branch or tag name',
          ),
        ...tokenFields,
      })
      .strict(),
    z
      .object({
        kind: z.literal('registry'),
        moduleId,
        packageName: z.string(),
        version: z
          .string()
          .max(256)
          .refine((value) => semver.exec(value)?.[0] === value, 'Use an exact semver version'),
        ...tokenFields,
      })
      .strict(),
  ])
  .superRefine((body, ctx) => {
    if (body.kind === 'registry' && body.packageName !== registryPrefix + body.moduleId)
      ctx.addIssue({
        code: 'custom',
        path: ['packageName'],
        message: 'Package must be @haive-module/<moduleId>',
      });
    if (body.clearToken && body.token)
      ctx.addIssue({
        code: 'custom',
        path: ['token'],
        message: 'Choose a token or clear the stored token',
      });
  });

const writable = () => process.env.HAIVE_PUBLISHED_INSTALL === 'true';
const secretKey = (id: string) => 'module_source:' + id + ':token';
const fetching = (status: string | null | undefined) =>
  status === 'queued' || status === 'fetching';

function assertWritable() {
  if (!writable())
    throw new HttpError(
      409,
      'This source checkout is read-only. Use pnpm module add.',
      'source_checkout',
    );
}
function sourceWriteError(error: unknown): never {
  if (isLockNotAvailable(error))
    throw new HttpError(
      503,
      'Another lifecycle action is changing this module; try again.',
      'module-busy',
    );
  if (isUniqueViolationOf(error, 'module_sources_module_id_unique'))
    throw new HttpError(409, 'A source for this module id already exists', 'module_source_exists');
  throw error;
}

export function moduleSourceRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin);
  routes.get('/', async (c) =>
    c.json({
      writable: writable(),
      fetchConfigured: !!process.env.HAIVE_OWN_MODULES_HOST_DIR,
      sources: await getDb()
        .select()
        .from(schema.moduleSources)
        .orderBy(asc(schema.moduleSources.moduleId)),
    }),
  );

  routes.post('/:sourceId/fetch', async (c) => {
    assertWritable();
    const id = c.req.param('sourceId');
    if (!isUuid(id)) throw new HttpError(404, 'Not found');
    const body = z
      .object({ refresh: z.boolean().optional() })
      .strict()
      .parse(await c.req.json());
    const event: AuditEvent = {
      actorUserId: c.get('userId'),
      action: 'module_source.fetch',
      targetType: 'module_source',
      targetId: id,
      metadata: { refresh: body.refresh === true },
    };
    const source = await getDb()
      .transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
        const [row] = await tx
          .select()
          .from(schema.moduleSources)
          .where(eq(schema.moduleSources.id, id))
          .for('update');
        if (!row) throw new HttpError(404, 'Module source not found');
        if (row.kind !== 'git')
          throw new HttpError(
            409,
            'Registry fetch is unavailable: the builder requires rebuildable sources',
            'registry_fetch_unsupported',
          );
        if (fetching(row.fetchStatus))
          throw new HttpError(409, 'This source is already being fetched', 'module_source_busy');
        const [queued] = await tx
          .update(schema.moduleSources)
          .set({
            fetchStatus: 'queued',
            lastError: null,
            updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
            ...(body.refresh ? { resolvedSha: null, resolvedRef: null } : {}),
          })
          .where(eq(schema.moduleSources.id, id))
          .returning();
        await insertAuditEvent(tx, event);
        return queued!;
      })
      .catch(sourceWriteError);
    logAuditEvent(event);
    try {
      await getModuleSourceQueue().add(
        MODULE_SOURCE_JOB_NAMES.FETCH,
        { sourceId: id, moduleId: source.moduleId, requestedAt: source.updatedAt.toISOString() },
        {
          jobId: 'source-' + id + '-' + source.updatedAt.getTime(),
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch {
      // The worker's outbox sweep retries the committed queued state.
    }
    return c.json(source, 202);
  });

  for (const method of ['post', 'put'] as const) {
    routes[method](method === 'post' ? '/' : '/:sourceId', async (c) => {
      assertWritable();
      const id = method === 'put' ? c.req.param('sourceId')! : null;
      if (id !== null && !isUuid(id)) throw new HttpError(404, 'Not found');
      const body = sourceBody.parse(await c.req.json());
      const event: AuditEvent = {
        actorUserId: c.get('userId'),
        action: method === 'post' ? 'module_source.create' : 'module_source.update',
        targetType: 'module_source',
        metadata: {
          moduleId: body.moduleId,
          kind: body.kind,
          tokenSet: !!body.token,
          tokenCleared: !!body.clearToken,
        },
      };
      const source = await getDb()
        .transaction(async (tx) => {
          await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
          const previous =
            id === null
              ? null
              : (
                  await tx
                    .select()
                    .from(schema.moduleSources)
                    .where(eq(schema.moduleSources.id, id))
                    .for('update')
                )[0];
          if (id !== null && !previous) throw new HttpError(404, 'Module source not found');
          if (fetching(previous?.fetchStatus))
            throw new HttpError(409, 'This source is being fetched', 'module_source_busy');
          const values = {
            kind: body.kind,
            moduleId: body.moduleId,
            url: body.kind === 'git' ? body.url : null,
            ref: body.kind === 'git' ? body.ref : null,
            packageName: body.kind === 'registry' ? body.packageName : null,
            version: body.kind === 'registry' ? body.version : null,
            hasToken: body.clearToken ? false : !!body.token || previous?.hasToken || false,
            updatedAt: new Date(),
          };
          const sourceChanged =
            previous &&
            (['kind', 'moduleId', 'url', 'ref', 'packageName', 'version'] as const).some(
              (field) => previous[field] !== values[field],
            );
          const fetchState = sourceChanged
            ? {
                resolvedSha: null,
                resolvedRef: null,
                fetchStatus: null,
                fetchedAt: null,
                lastError: null,
              }
            : {};
          const [row] =
            id === null
              ? await tx
                  .insert(schema.moduleSources)
                  .values({ ...values, createdBy: c.get('userId') })
                  .returning()
              : await tx
                  .update(schema.moduleSources)
                  .set({ ...values, ...fetchState })
                  .where(eq(schema.moduleSources.id, id))
                  .returning();
          if (!row) throw new HttpError(404, 'Module source not found');
          if (body.clearToken) await secretsService.delete(secretKey(row.id), tx);
          else if (body.token)
            await secretsService.set(
              secretKey(row.id),
              body.token,
              'Module source access token',
              tx,
            );
          event.targetId = row.id;
          await insertAuditEvent(tx, event);
          return row;
        })
        .catch(sourceWriteError);
      logAuditEvent(event);
      return c.json(source, method === 'post' ? 201 : 200);
    });
  }

  routes.delete('/:sourceId', async (c) => {
    assertWritable();
    const id = c.req.param('sourceId');
    if (!isUuid(id)) throw new HttpError(404, 'Not found');
    const event: AuditEvent = {
      actorUserId: c.get('userId'),
      action: 'module_source.delete',
      targetType: 'module_source',
      targetId: id,
    };
    await getDb()
      .transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
        const [previous] = await tx
          .select()
          .from(schema.moduleSources)
          .where(eq(schema.moduleSources.id, id))
          .for('update');
        if (fetching(previous?.fetchStatus))
          throw new HttpError(409, 'This source is being fetched', 'module_source_busy');
        const [row] = await tx
          .delete(schema.moduleSources)
          .where(eq(schema.moduleSources.id, id))
          .returning();
        if (!row) throw new HttpError(404, 'Module source not found');
        event.metadata = { moduleId: row.moduleId, kind: row.kind };
        await secretsService.delete(secretKey(id), tx);
        await insertAuditEvent(tx, event);
      })
      .catch(sourceWriteError);
    logAuditEvent(event);
    return c.json({ deleted: true });
  });
  return routes;
}
