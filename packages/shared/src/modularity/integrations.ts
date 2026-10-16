import { z } from 'zod';
import { formSchemaSchema } from '../schemas/form.js';
import { HIDDEN_CHARACTER } from '../utils/hidden-characters.js';
import { TOOL_NAME_PATTERN, isCategoryId, isProviderId } from './contracts.js';

const httpsUrlSchema = z.string().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an absolute https url');

const providerIdSchema = z.string().refine((id) => isProviderId(id), 'invalid provider id');
const categoryIdSchema = z.string().refine((id) => isCategoryId(id), 'invalid category id');

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// A final label that starts with a letter keeps IP literals out.
const API_HOST_PATTERN = new RegExp(`^(?:${HOST_LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`);
const apiHostSchema = z
  .string()
  .max(253)
  .regex(API_HOST_PATTERN, 'must be a bare lowercase hostname such as api.example.com');

const scopeSetSchema = z.strictObject({
  read: z.array(z.string()),
  write: z.array(z.string()),
});

const jsonPointerSchema = z.string().regex(/^(\/([^/~]|~[01])*)+$/, 'must be a JSON pointer');

export const userInfoSpecSchema = z.strictObject({
  url: httpsUrlSchema,
  idPointer: jsonPointerSchema,
  labelPointer: jsonPointerSchema,
});
export type UserInfoSpec = z.infer<typeof userInfoSpecSchema>;

/** What buildAuthorizeUrl sets itself: a provider's own parameters may not take these names. */
export const AUTHORIZE_RESERVED_PARAMS: ReadonlySet<string> = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
]);

// HIDDEN_CHARACTER leaves TAB and LF allowed, and one line holds neither.
const isPrintableLine = (text: string) => !HIDDEN_CHARACTER.test(text) && !/[\t\n]/.test(text);

const authorizeParamsSchema = z.record(z.string(), z.string()).superRefine((params, ctx) => {
  for (const [name, value] of Object.entries(params)) {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: [name] });
    if (name === '') fail('the name must not be empty');
    else if (!isPrintableLine(name)) fail('the name must be one printable line');
    else if (AUTHORIZE_RESERVED_PARAMS.has(name.toLowerCase())) {
      fail(`${name} is set by the sign-in itself and cannot be overridden`);
    }
    if (!isPrintableLine(value)) fail('the value must be one printable line');
  }
});

export const authMethodSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('oauth2'),
    authorizeUrl: httpsUrlSchema,
    authorizeParams: authorizeParamsSchema.optional(),
    tokenUrl: httpsUrlSchema,
    revokeUrl: httpsUrlSchema.optional(),
    scopes: scopeSetSchema,
    pkce: z.literal(true),
    clientRegistration: z.array(z.enum(['preregistered', 'cimd', 'dcr'])).min(1),
    userInfo: userInfoSpecSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('device'),
    deviceCodeUrl: httpsUrlSchema,
    tokenUrl: httpsUrlSchema,
    scopes: scopeSetSchema,
    userInfo: userInfoSpecSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('token'),
    form: formSchemaSchema,
    help: z.string(),
  }),
]);
export type AuthMethodSpec = z.infer<typeof authMethodSpecSchema>;

export const integrationOperationSchema = z.strictObject({
  opId: z.string().regex(TOOL_NAME_PATTERN),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  access: z.enum(['read', 'write']),
});
export type IntegrationOperation = z.infer<typeof integrationOperationSchema>;

const mcpSurfaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('remote'), url: httpsUrlSchema }),
  z
    .strictObject({
      kind: z.literal('stdio'),
      image: z.string().min(1).optional(),
      package: z.string().min(1).optional(),
      version: z.string().min(1),
    })
    .refine((s) => (s.image === undefined) !== (s.package === undefined), {
      message: 'exactly one of image or package is required',
    }),
]);
export type IntegrationMcpSurface = z.infer<typeof mcpSurfaceSchema>;

export const integrationProviderSpecSchema = z
  .strictObject({
    id: providerIdSchema,
    displayName: z.string().min(1),
    categories: z.array(categoryIdSchema).min(1),
    selfHosted: z.boolean(),
    auth: z.array(authMethodSpecSchema).min(1),
    mcp: mcpSurfaceSchema.optional(),
    operations: z.array(integrationOperationSchema).optional(),
    entitlementId: z.string().min(1).optional(),
    apiHosts: z.array(apiHostSchema).min(1).optional(),
  })
  .refine((p) => new Set(p.categories).size === p.categories.length, {
    message: 'categories must be unique',
    path: ['categories'],
  })
  .refine((p) => new Set(p.auth.map((a) => a.kind)).size === p.auth.length, {
    message: 'each auth kind may appear once',
    path: ['auth'],
  })
  .refine(
    (p) => {
      const ids = (p.operations ?? []).map((o) => o.opId);
      return new Set(ids).size === ids.length;
    },
    { message: 'operation ids must be unique', path: ['operations'] },
  )
  .refine((p) => p.mcp !== undefined || (p.operations ?? []).length > 0, {
    message: 'at least one of mcp or a non-empty operations list is required',
  });
export type IntegrationProviderSpec = z.infer<typeof integrationProviderSpecSchema>;

export const integrationCategorySpecSchema = z.strictObject({
  id: categoryIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
});
export type IntegrationCategorySpec = z.infer<typeof integrationCategorySpecSchema>;
