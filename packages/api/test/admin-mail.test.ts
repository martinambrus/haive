import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { configService, secretsService } from '@haive/shared';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => ({ role: 'admin', audits: [] as unknown[], auditFails: false }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-000000000001');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('../src/db.js', () => {
  const tx = { execute: vi.fn(), transaction: async (run: (tx: unknown) => unknown) => run(tx) };
  return {
    getDb: () => ({ ...tx, transaction: async (run: (tx: unknown) => unknown) => run(tx) }),
  };
});
vi.mock('../src/lib/audit.js', () => ({
  insertAuditEvent: async (_tx: unknown, event: unknown) => {
    if (h.auditFails) throw new Error('audit unavailable');
    h.audits.push(event);
  },
  logAuditEvent: vi.fn(),
}));
const app = new Hono<AppEnv>().route('/admin', adminRoutes);
app.onError(errorHandler);
const settings = {
  enabled: true,
  smtpHost: 'relay.internal',
  smtpPort: 587,
  secure: false,
  user: 'smtp-user',
  from: 'haive@example.test',
  fromName: 'Haive',
};
let password: string | null;
let stored: Map<string, string>;
const request = (method: string, body?: unknown, path = '/admin/mail') =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  h.role = 'admin';
  h.audits = [];
  h.auditFails = false;
  password = 'sentinel-password';
  stored = new Map(
    Object.entries(settings).map(([key, value]) => [`config:mail:${key}`, String(value)]),
  );
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) => stored.get(key) ?? null);
  vi.spyOn(configService, 'set').mockImplementation(async (key, value) => {
    stored.set(key, value);
  });
  vi.spyOn(secretsService, 'getFresh').mockImplementation(async () => password);
  vi.spyOn(secretsService, 'set').mockImplementation(async (_key, value) => {
    password = value;
  });
});

describe('administrator SMTP settings', () => {
  it('GET exposes only settings and password presence', async () => {
    const response = await request('GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...settings, passwordSet: true });
    password = null;
    expect(await (await request('GET')).json()).toEqual({ ...settings, passwordSet: false });
  });
  it('GET loads an incomplete saved state so the card can repair it', async () => {
    stored.set('config:mail:enabled', 'true');
    stored.set('config:mail:smtpHost', '');
    const response = await request('GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, smtpHost: '' });
  });
  it.each([undefined, '', '   '])(
    'PUT keeps the password when blank or absent (%s)',
    async (value) => {
      const response = await request('PUT', { ...settings, password: value });
      expect(response.status).toBe(200);
      expect(password).toBe('sentinel-password');
      expect(secretsService.set).not.toHaveBeenCalled();
    },
  );
  it('PUT stores a password in the audited transaction without exposing it', async () => {
    const response = await request('PUT', { ...settings, password: 'new-sentinel' });
    expect(response.status).toBe(200);
    expect(secretsService.set).toHaveBeenCalledWith(
      'mail_smtp_password',
      'new-sentinel',
      expect.any(String),
      expect.any(Object),
    );
    expect(JSON.stringify(await response.json())).not.toContain('new-sentinel');
    expect(JSON.stringify(h.audits)).not.toMatch(/new-sentinel|sentinel-password|smtp-user/);
    expect(h.audits).toEqual([expect.objectContaining({ action: 'config.mail' })]);
  });
  it('an audit failure refuses the save before any configuration or password write', async () => {
    h.auditFails = true;
    expect((await request('PUT', { ...settings, password: 'new-sentinel' })).status).toBe(500);
    expect(configService.set).not.toHaveBeenCalled();
    expect(secretsService.set).not.toHaveBeenCalled();
  });
  it.each([
    ['GET', undefined],
    ['PUT', settings],
    ['POST', { to: 'test@example.test' }],
  ] as const)('refuses non-admin %s', async (method, body) => {
    h.role = 'user';
    expect(
      (await request(method, body, method === 'POST' ? '/admin/mail/test' : undefined)).status,
    ).toBe(403);
    expect(configService.getFresh).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });
  it('disabled test send returns a typed refusal and records the attempt', async () => {
    stored.set('config:mail:enabled', 'false');
    const response = await request('POST', { to: 'test@example.test' }, '/admin/mail/test');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'mail_disabled',
      error: expect.any(String),
    });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'mail.test' })]);
  });
  it('an unauditable test sends nothing', async () => {
    h.auditFails = true;
    expect((await request('POST', { to: 'test@example.test' }, '/admin/mail/test')).status).toBe(
      500,
    );
    expect(configService.getFresh).not.toHaveBeenCalled();
  });
  it.each([
    { smtpPort: 0 },
    { smtpPort: 65536 },
    { smtpHost: 'smtp://relay' },
    { from: 'bad' },
    { secure: 'false' },
  ])('refuses invalid settings %j', async (patch) => {
    expect((await request('PUT', { ...settings, ...patch })).status).toBe(400);
    expect(configService.set).not.toHaveBeenCalled();
  });
  it('refuses an invalid test recipient', async () => {
    expect((await request('POST', { to: 'bad' }, '/admin/mail/test')).status).toBe(400);
    expect(h.audits).toEqual([]);
  });
});
