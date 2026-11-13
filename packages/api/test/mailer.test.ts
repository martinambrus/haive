import net from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigUnavailableError, configService, secretsService } from '@haive/shared';
import { MAIL_TIMEOUTS, sendMail } from '../src/lib/mailer.js';

const message = { to: 'recipient@example.test', subject: 'SMTP control', text: 'Delivered body' };
let stored: Map<string, string>;
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
beforeEach(() => {
  stored = new Map(
    Object.entries({
      enabled: 'true',
      smtpHost: '127.0.0.1',
      smtpPort: '1',
      secure: 'false',
      user: '',
      from: 'sender@example.test',
      fromName: 'Haive control',
    }).map(([key, value]) => [`config:mail:${key}`, value]),
  );
  vi.spyOn(configService, 'getFresh').mockImplementation(async (key) => stored.get(key) ?? null);
  vi.spyOn(secretsService, 'getFresh').mockResolvedValue(null);
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});
async function server(onConnection: (socket: net.Socket) => void) {
  const relay = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    onConnection(socket);
  });
  servers.push(relay);
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  stored.set('config:mail:smtpPort', String((relay.address() as net.AddressInfo).port));
}
describe('sendMail', () => {
  it.each([false, true])(
    'sets TLS mode %s, bounded deadlines and fresh credentials without weakening certificates',
    async (secure) => {
      stored.set('config:mail:secure', String(secure));
      stored.set('config:mail:smtpPort', secure ? '465' : '587');
      stored.set('config:mail:user', 'smtp-user');
      vi.mocked(secretsService.getFresh)
        .mockResolvedValueOnce('first-password')
        .mockResolvedValueOnce('second-password');
      const transport = { sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() };
      const create = vi
        .spyOn(nodemailer, 'createTransport')
        .mockReturnValue(transport as unknown as ReturnType<typeof nodemailer.createTransport>);
      expect(await sendMail(message)).toEqual({ ok: true });
      expect(await sendMail(message)).toEqual({ ok: true });
      expect(create).toHaveBeenNthCalledWith(1, {
        host: '127.0.0.1',
        port: secure ? 465 : 587,
        secure,
        auth: { user: 'smtp-user', pass: 'first-password' },
        // Credentials never cross a plaintext link: without implicit TLS, STARTTLS is required.
        requireTLS: !secure,
        ...MAIL_TIMEOUTS,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      expect(create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ auth: { user: 'smtp-user', pass: 'second-password' } }),
      );
      expect(transport.close).toHaveBeenCalledTimes(2);
    },
  );
  it('preserves a typed configuration outage for the API retryable 503 boundary', async () => {
    const error = new ConfigUnavailableError('getFresh');
    vi.mocked(configService.getFresh).mockRejectedValue(error);
    await expect(sendMail(message)).rejects.toBe(error);
  });
  it('refuses disabled mail before connecting', async () => {
    stored.set('config:mail:enabled', 'false');
    expect(await sendMail(message)).toMatchObject({ ok: false, code: 'mail_disabled' });
    expect(secretsService.getFresh).not.toHaveBeenCalled();
  });
  it('refuses missing SMTP configuration', async () => {
    stored.set('config:mail:smtpHost', '');
    expect(await sendMail(message)).toMatchObject({ ok: false, code: 'mail_not_configured' });
  });
  it('delivers subject, text, HTML, sender and recipient over a real SMTP socket and rereads settings', async () => {
    const deliveries: string[] = [];
    await server((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 control ESMTP\r\n');
      let pending = '';
      let data = false;
      let body = '';
      socket.on('data', (chunk) => {
        pending += chunk;
        while (pending.includes('\r\n')) {
          const end = pending.indexOf('\r\n');
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (data) {
            if (line !== '.') {
              body += line + '\r\n';
              continue;
            }
            deliveries.push(body);
            body = '';
            data = false;
            socket.write('250 accepted\r\n');
          } else if (line.startsWith('EHLO')) socket.write('250 control\r\n');
          else if (line === 'DATA') {
            data = true;
            socket.write('354 message\r\n');
          } else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    });
    expect(await sendMail({ ...message, html: '<p>HTML body</p>' })).toEqual({ ok: true });
    expect(deliveries[0]).toContain('Subject: SMTP control');
    expect(deliveries[0]).toContain('From: Haive control <sender@example.test>');
    expect(deliveries[0]).toContain('To: recipient@example.test');
    expect(deliveries[0]).toContain('Delivered body');
    expect(deliveries[0]).toContain('<p>HTML body</p>');
    stored.set('config:mail:fromName', 'Updated sender');
    expect(await sendMail(message)).toEqual({ ok: true });
    expect(deliveries[1]).toContain('From: Updated sender <sender@example.test>');
  });
  it('bounds a stalled SMTP greeting using an injected socket deadline', async () => {
    expect(MAIL_TIMEOUTS).toEqual({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    await server(() => {});
    expect(
      await sendMail(message, { connectionTimeout: 50, greetingTimeout: 20, socketTimeout: 50 }),
    ).toEqual({ ok: false, code: 'mail_send_failed', error: expect.stringMatching(/timed out/i) });
  });
  it('never returns a raw SMTP error transcript or credentials', async () => {
    await server((socket) => socket.end('535 sentinel-password smtp-user secret transcript\r\n'));
    const result = await sendMail(message);
    expect(result).toMatchObject({ ok: false, code: 'mail_send_failed' });
    expect(JSON.stringify(result)).not.toMatch(/sentinel-password|smtp-user|transcript/);
  });
});
