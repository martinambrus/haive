import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '../src/logger/index.js';

afterEach(() => vi.restoreAllMocks());

it('redacts handshake secrets and editor cookies from structured child logs', () => {
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[
    pino.symbols.streamSym
  ]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  const secret = 'synthetic-handshake-secret';
  const cookie = 'synthetic-editor-cookie';
  const log = logger.child({ module: 'editor-control' });
  log.info(
    {
      secret,
      body: { secret },
      req: { body: { secret }, headers: { cookie: `haive_editor_task_id=${cookie}` } },
      headers: {
        Cookie: `haive_editor_task_id=${cookie}`,
        'set-cookie': [`haive_editor_repo_id=${cookie}`],
      },
      cookies: { haive_editor_task_id: cookie },
      haive_editor_task_id: cookie,
      safe: 'kept',
    },
    'control',
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain(secret);
  expect(lines[0]).not.toContain(cookie);
  expect(JSON.parse(lines[0]!)).toMatchObject({ safe: 'kept', module: 'editor-control' });
});

it('redacts nested bodies and cookies inside arrays without mutating caller data', () => {
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[
    pino.symbols.streamSym
  ]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  const body = { secret: 'synthetic-nested-secret', safe: 1 };
  logger.info(
    { batch: [{ nested: { body, cookies: { haive_editor_repo_id: 'synthetic-cookie' } } }] },
    'control',
  );
  expect(lines[0]).not.toContain(body.secret);
  expect(lines[0]).not.toContain('synthetic-cookie');
  expect(body).toEqual({ secret: 'synthetic-nested-secret', safe: 1 });
});

it('redacts editor credentials in child bindings and serialized error fields', () => {
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[
    pino.symbols.streamSym
  ]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  logger.child({ body: { secret: 'synthetic-bound-secret' } }).info(
    {
      err: Object.assign(new Error('ordinary'), { secret: 'synthetic-error-secret' }),
    },
    'control',
  );
  expect(lines[0]).not.toContain('synthetic-bound-secret');
  expect(lines[0]).not.toContain('synthetic-error-secret');
  expect(JSON.parse(lines[0]!).err.message).toBe('ordinary');
});
