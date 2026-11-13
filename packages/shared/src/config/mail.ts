import { z } from 'zod';

export const MAIL_DEFAULTS = {
  enabled: false,
  smtpHost: '',
  smtpPort: 587,
  secure: false,
  user: '',
  from: '',
  fromName: 'Haive',
} as const;

const headerText = z
  .string()
  .max(320)
  .regex(/^[^\r\n\x00]*$/);
/** Field rules only. The admin form reads stored values with this, so an incomplete save
 *  (enabled written, host not) still loads and can be repaired. */
export const mailSettingsFieldsSchema = z.object({
  enabled: z.boolean(),
  smtpHost: z
    .string()
    .trim()
    .max(253)
    .regex(/^[a-zA-Z0-9_.:-]*$/),
  smtpPort: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: headerText,
  from: z.union([z.literal(''), z.email()]),
  fromName: headerText,
});
export const mailSettingsSchema = mailSettingsFieldsSchema.superRefine((settings, ctx) => {
  if (!settings.enabled) return;
  for (const key of ['smtpHost', 'from'] as const) {
    if (!settings[key])
      ctx.addIssue({ code: 'custom', path: [key], message: 'Required when mail is enabled' });
  }
});
export type MailSettings = z.infer<typeof mailSettingsSchema>;

/** Environment values seed missing keys only; a later boot never overwrites an admin save. */
export function mailSeedDefaults(env: NodeJS.ProcessEnv): MailSettings {
  const boolean = (key: string, fallback: boolean) => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`Invalid boolean in ${key}`);
  };
  return mailSettingsSchema.parse({
    enabled: boolean('HAIVE_MAIL_ENABLED', MAIL_DEFAULTS.enabled),
    smtpHost: env.HAIVE_MAIL_SMTP_HOST ?? MAIL_DEFAULTS.smtpHost,
    smtpPort:
      env.HAIVE_MAIL_SMTP_PORT === undefined
        ? MAIL_DEFAULTS.smtpPort
        : Number(env.HAIVE_MAIL_SMTP_PORT),
    secure: boolean('HAIVE_MAIL_SECURE', MAIL_DEFAULTS.secure),
    user: env.HAIVE_MAIL_USER ?? MAIL_DEFAULTS.user,
    from: env.HAIVE_MAIL_FROM ?? MAIL_DEFAULTS.from,
    fromName: env.HAIVE_MAIL_FROM_NAME ?? MAIL_DEFAULTS.fromName,
  });
}
