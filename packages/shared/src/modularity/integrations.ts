import { z } from 'zod';
import { formSchemaSchema } from '../schemas/form.js';
import { isCategoryId, isProviderId } from './contracts.js';

const OP_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const httpsUrlSchema = z.string().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an absolute https url');

const providerIdSchema = z.string().refine((id) => isProviderId(id), 'invalid provider id');
const categoryIdSchema = z.string().refine((id) => isCategoryId(id), 'invalid category id');

const scopeSetSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
});

const jsonPointerSchema = z.string().regex(/^(\/([^/~]|~[01])*)+$/, 'must be a JSON pointer');

export const userInfoSpecSchema = z.object({
  url: httpsUrlSchema,
  idPointer: jsonPointerSchema,
  labelPointer: jsonPointerSchema,
});
export type UserInfoSpec = z.infer<typeof userInfoSpecSchema>;

export const authMethodSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('oauth2'),
    authorizeUrl: httpsUrlSchema,
    tokenUrl: httpsUrlSchema,
    revokeUrl: httpsUrlSchema.optional(),
    scopes: scopeSetSchema,
    pkce: z.literal(true),
    clientRegistration: z.array(z.enum(['preregistered', 'cimd', 'dcr'])).min(1),
    userInfo: userInfoSpecSchema.optional(),
  }),
  z.object({
    kind: z.literal('device'),
    deviceCodeUrl: httpsUrlSchema,
    tokenUrl: httpsUrlSchema,
    scopes: scopeSetSchema,
    userInfo: userInfoSpecSchema.optional(),
  }),
  z.object({
    kind: z.literal('token'),
    form: formSchemaSchema,
    help: z.string(),
  }),
]);
export type AuthMethodSpec = z.infer<typeof authMethodSpecSchema>;

export const integrationOperationSchema = z.object({
  opId: z.string().regex(OP_ID_PATTERN),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  access: z.enum(['read', 'write']),
});
export type IntegrationOperation = z.infer<typeof integrationOperationSchema>;

const mcpSurfaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), url: httpsUrlSchema }),
  z
    .object({
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
  .object({
    id: providerIdSchema,
    displayName: z.string().min(1),
    categories: z.array(categoryIdSchema).min(1),
    selfHosted: z.boolean(),
    auth: z.array(authMethodSpecSchema).min(1),
    mcp: mcpSurfaceSchema.optional(),
    operations: z.array(integrationOperationSchema).optional(),
    entitlementId: z.string().min(1).optional(),
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

export const integrationCategorySpecSchema = z.object({
  id: categoryIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
});
export type IntegrationCategorySpec = z.infer<typeof integrationCategorySpecSchema>;
