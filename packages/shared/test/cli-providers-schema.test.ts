import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  createCliProviderRequestSchema,
  updateCliProviderRequestSchema,
} from '../src/schemas/cli-providers.js';

const BASE_VALID = {
  name: 'gemini' as const,
  label: 'My Gemini',
  authMode: 'subscription' as const,
};

describe('createCliProviderRequestSchema isolateAuth', () => {
  it('omits isolateAuth from a minimal valid create payload', () => {
    const parsed = createCliProviderRequestSchema.parse(BASE_VALID);
    expect(parsed.isolateAuth).toBeUndefined();
  });

  it('accepts isolateAuth=true', () => {
    const parsed = createCliProviderRequestSchema.parse({ ...BASE_VALID, isolateAuth: true });
    expect(parsed.isolateAuth).toBe(true);
  });

  it('accepts isolateAuth=false', () => {
    const parsed = createCliProviderRequestSchema.parse({ ...BASE_VALID, isolateAuth: false });
    expect(parsed.isolateAuth).toBe(false);
  });

  it('rejects non-boolean isolateAuth', () => {
    expect(() =>
      createCliProviderRequestSchema.parse({ ...BASE_VALID, isolateAuth: 'yes' }),
    ).toThrow();
  });
});

describe('updateCliProviderRequestSchema isolateAuth', () => {
  it('accepts isolateAuth alone in a partial update', () => {
    const parsed = updateCliProviderRequestSchema.parse({ isolateAuth: true });
    expect(parsed.isolateAuth).toBe(true);
  });

  it('accepts an empty patch (all fields optional)', () => {
    const parsed = updateCliProviderRequestSchema.parse({});
    expect(parsed.isolateAuth).toBeUndefined();
  });
});

describe('providers envVars with an empty secret-named value', () => {
  const issuesOf = (schema: ZodType, input: unknown) => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues;
  };

  it('refuses an empty secret-named key on create, naming it', () => {
    const issues = issuesOf(createCliProviderRequestSchema, {
      ...BASE_VALID,
      envVars: { MY_API_KEY: '' },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(['envVars', 'MY_API_KEY']);
    expect(issues[0]!.message).toContain('MY_API_KEY');
  });

  it('refuses it on a partial update too', () => {
    const issues = issuesOf(updateCliProviderRequestSchema, { envVars: { MY_API_KEY: '' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(['envVars', 'MY_API_KEY']);
  });

  it('names every empty secret-named key', () => {
    const issues = issuesOf(createCliProviderRequestSchema, {
      ...BASE_VALID,
      envVars: { A_TOKEN: '', B_SECRET: '', PLAIN: '' },
    });
    expect(issues.map((i) => i.path.join('.')).sort()).toEqual([
      'envVars.A_TOKEN',
      'envVars.B_SECRET',
    ]);
  });

  it.each(['X_KEY', 'x_token', 'APP_SECRET', 'DB_PASSWORD', 'DB_PASSWD', 'AWS_CREDENTIALS'])(
    'refuses an empty %s',
    (name) => {
      const issues = issuesOf(createCliProviderRequestSchema, {
        ...BASE_VALID,
        envVars: { [name]: '' },
      });
      expect(issues.map((i) => i.path.join('.'))).toEqual([`envVars.${name}`]);
    },
  );

  it('accepts a secret-named key with a value', () => {
    const value = randomBytes(8).toString('hex');
    const parsed = createCliProviderRequestSchema.parse({
      ...BASE_VALID,
      envVars: { MY_API_KEY: value },
    });
    expect(parsed.envVars?.MY_API_KEY === value).toBe(true);
  });

  it('keeps a non-secret empty value', () => {
    const parsed = createCliProviderRequestSchema.parse({
      ...BASE_VALID,
      envVars: { FOO_FLAG: '' },
    });
    expect(parsed.envVars).toEqual({ FOO_FLAG: '' });
  });

  it('accepts the web form payload shape and returns envVars intact', () => {
    const form = {
      name: 'claude-code' as const,
      label: 'p',
      executablePath: '',
      wrapperPath: '',
      wrapperContent: '',
      envVars: { ANTHROPIC_BASE_URL: 'https://api.example', FOO_FLAG: '' },
      cliArgs: [],
      rulesContent: 'rules',
      authMode: 'api_key' as const,
      cliVersion: null,
      effortLevel: null,
      model: null,
      modelfile: null,
      sandboxDockerfileExtra: '',
      enabled: true,
      isolateAuth: false,
      disableThinking: false,
      networkPolicy: { mode: 'full' as const, domains: [], ips: [] },
      egressDomains: [],
    };
    expect(createCliProviderRequestSchema.parse(form).envVars).toEqual(form.envVars);
    const { name: _name, ...update } = form;
    expect(updateCliProviderRequestSchema.parse(update).envVars).toEqual(form.envVars);
  });
});
