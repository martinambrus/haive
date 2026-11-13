import nodemailer from 'nodemailer';
import {
  CONFIG_KEYS,
  MAIL_DEFAULTS,
  SECRET_KEYS,
  configService,
  secretsService,
  mailSettingsFieldsSchema,
  mailSettingsSchema,
  rethrowIfConfigUnavailable,
  logger,
  type MailSettings,
} from '@haive/shared';

export const MAIL_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;
export type MailTimeouts = { [K in keyof typeof MAIL_TIMEOUTS]: number };
export type MailResult =
  | { ok: true }
  | {
      ok: false;
      code: 'mail_disabled' | 'mail_not_configured' | 'mail_send_failed';
      error: string;
    };
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export const MAIL_FIELDS = {
  enabled: CONFIG_KEYS.MAIL_ENABLED,
  smtpHost: CONFIG_KEYS.MAIL_SMTP_HOST,
  smtpPort: CONFIG_KEYS.MAIL_SMTP_PORT,
  secure: CONFIG_KEYS.MAIL_SECURE,
  user: CONFIG_KEYS.MAIL_USER,
  from: CONFIG_KEYS.MAIL_FROM,
  fromName: CONFIG_KEYS.MAIL_FROM_NAME,
} as const;

/** Bypass process caches: a save applies to the very next send, including the password. */
async function readMailFields(): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(MAIL_FIELDS).map(async ([name, key]) => {
      const raw = await configService.getFresh(key);
      const fallback = MAIL_DEFAULTS[name as keyof MailSettings];
      const value =
        raw === null
          ? fallback
          : typeof fallback === 'boolean'
            ? raw === 'true' || raw === '1'
            : typeof fallback === 'number'
              ? Number(raw)
              : raw;
      return [name, value];
    }),
  );
  return Object.fromEntries(entries);
}

export async function readMailSettings(): Promise<MailSettings> {
  return mailSettingsSchema.parse(await readMailFields());
}

/** For the admin form: loads an incomplete saved state so the admin can repair it. */
export async function readStoredMailSettings(): Promise<MailSettings> {
  return mailSettingsFieldsSchema.parse(await readMailFields());
}

/** Admin-only configuration chooses this endpoint. Per api-auth.md it may name an internal
 * relay, so it deliberately uses the plain SMTP transport rather than non-admin egress guards.
 * No connection is pooled or retained across calls, and certificate checks stay enabled. */
export async function sendMail(
  message: MailMessage,
  timeouts: MailTimeouts = MAIL_TIMEOUTS,
): Promise<MailResult> {
  let settings: MailSettings;
  try {
    settings = await readMailSettings();
  } catch (error) {
    rethrowIfConfigUnavailable(error);
    return {
      ok: false,
      code: 'mail_not_configured',
      error: 'Mail settings are unavailable or incomplete.',
    };
  }
  if (!settings.enabled) return { ok: false, code: 'mail_disabled', error: 'Mail is disabled.' };
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  try {
    const password = await secretsService.getFresh(SECRET_KEYS.MAIL_SMTP_PASSWORD);
    transport = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.secure,
      // Credentials never cross a plaintext link: without implicit TLS, STARTTLS is required.
      ...(settings.user
        ? { auth: { user: settings.user, pass: password ?? '' }, requireTLS: !settings.secure }
        : {}),
      ...timeouts,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    await transport.sendMail({
      from: { name: settings.fromName, address: settings.from },
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    });
    return { ok: true };
  } catch (error) {
    // SMTP errors can quote AUTH commands, credentials and server transcripts. Translate only
    // known structural codes into fixed copy before using the shared, bounded error formatter.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const diagnosis =
      code === 'ETIMEDOUT'
        ? 'Mail delivery timed out.'
        : code === 'EAUTH'
          ? 'SMTP authentication failed. Check the saved credentials.'
          : 'Mail delivery failed. Check the SMTP settings and relay.';
    // Only nodemailer's short error code is logged (e.g. ETIMEDOUT, EAUTH), never its message.
    const smtpCode = typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : 'unknown';
    logger.warn({ code: 'mail_send_failed', smtpCode }, 'Mail delivery failed');
    return { ok: false, code: 'mail_send_failed', error: diagnosis };
  } finally {
    transport?.close();
  }
}
