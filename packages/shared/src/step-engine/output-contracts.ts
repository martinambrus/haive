import { z } from 'zod';
import { REVIEW_SEVERITIES } from '../review/severity.js';

/** References are the only declarations a producer may supply. The host owns the schemas. */
export const CODE_REVIEW_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.code-review',
  version: 1,
} as const);
export const CODE_AUDIT_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.code-audit',
  version: 1,
} as const);
export type StepOutputContractRef =
  typeof CODE_REVIEW_OUTPUT_CONTRACT | typeof CODE_AUDIT_OUTPUT_CONTRACT;
export const STEP_ROLES = Object.freeze({
  codeReview: '08c-code-review',
  codeAudit: '08c2-code-audit',
} as const);
export type StepRoleId = (typeof STEP_ROLES)[keyof typeof STEP_ROLES];

export function stepRoleOutputContract(role: StepRoleId): StepOutputContractRef {
  return role === STEP_ROLES.codeReview ? CODE_REVIEW_OUTPUT_CONTRACT : CODE_AUDIT_OUTPUT_CONTRACT;
}

/** Exact id + version, with no module-supplied validator or compatibility assertion. */
export function parseStepOutputContractRef(value: unknown): StepOutputContractRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).length !== 2 || !Object.hasOwn(ref, 'id') || !Object.hasOwn(ref, 'version'))
    return null;
  if (ref.version !== 1) return null;
  if (ref.id === CODE_REVIEW_OUTPUT_CONTRACT.id) return CODE_REVIEW_OUTPUT_CONTRACT;
  if (ref.id === CODE_AUDIT_OUTPUT_CONTRACT.id) return CODE_AUDIT_OUTPUT_CONTRACT;
  return null;
}

export function stepOutputContractsEqual(expected: unknown, actual: unknown): boolean {
  const ref = parseStepOutputContractRef(expected);
  return ref !== null && ref === parseStepOutputContractRef(actual);
}

// Schemas and registry stay private: publishing a Zod object would let a consumer mutate its
// internals for every producer. Passthrough applies at EVERY object boundary. No defaults,
// coercion or transformations: successful validation never rewrites the persisted value.
// Unknown extension keys survive parsing but are not declared fields for TypeScript's
// union narrowing (e.g. peer.lines versus security.line). Infer the known shape recursively.
type ContractShape<T> = T extends readonly unknown[]
  ? { [K in keyof T]: ContractShape<T[K]> }
  : T extends object
    ? {
        [K in keyof T as string extends K ? never : number extends K ? never : K]: ContractShape<
          T[K]
        >;
      }
    : T;

const coverageSchema = z
  .object({
    listed: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    scanFailed: z.literal(true).optional(),
  })
  .passthrough();
export type FileCoverage = ContractShape<z.infer<typeof coverageSchema>>;

const findingFields = {
  upstream: z.enum(['infrastructure', 'dependency', 'unknown']).nullable().optional(),
  severity: z.enum(REVIEW_SEVERITIES),
  path: z.string().optional(),
  issue: z.string(),
  snippet: z.string().optional(),
  fix: z.string().optional(),
  refuted: z.boolean().optional(),
};
const peerFindingSchema = z
  .object({
    ...findingFields,
    lines: z.string().optional(),
    rule: z.string().optional(),
  })
  .passthrough();
const securityFindingSchema = z
  .object({
    ...findingFields,
    in_scope: z.unknown().optional(),
    line: z.union([z.string(), z.number()]).optional(),
    cwe: z.string().optional(),
    attack: z.string().optional(),
  })
  .passthrough();
const codeReviewOutputSchema = z
  .object({
    reviewed: z.boolean(),
    peer: z
      .object({
        verdict: z.string(),
        findings: z.array(peerFindingSchema),
        positives: z.array(z.string()),
      })
      .passthrough(),
    security: z
      .object({ verdict: z.string(), findings: z.array(securityFindingSchema) })
      .passthrough(),
    extraLenses: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          verdict: z.string(),
          findings: z.array(peerFindingSchema),
        })
        .passthrough(),
    ),
    blocking: z.boolean(),
    reviewIncomplete: z.boolean(),
    advisoryVerdict: z.boolean(),
    coverage: coverageSchema.nullable(),
    refutedCount: z.number(),
    counts: z.object({ peer: z.number(), securityCriticalHigh: z.number() }).passthrough(),
    recurringNote: z.string(),
    ruleConflicts: z
      .array(
        z
          .object({ rule: z.string(), file: z.string().optional(), reason: z.string() })
          .passthrough(),
      )
      .optional(),
    peerInvocationId: z.string().nullable().optional(),
    changeFingerprint: z.string().optional(),
  })
  .passthrough();
const codeAuditOutputSchema = z
  .object({
    audited: z.boolean(),
    findings: z.array(
      z
        .object({
          severity: z.enum(REVIEW_SEVERITIES),
          path: z.string().optional(),
          lines: z.string().optional(),
          issue: z.string().optional(),
          fix: z.string().optional(),
        })
        .passthrough(),
    ),
    coverage: coverageSchema.nullable(),
  })
  .passthrough();
export type CodeReviewOutput = ContractShape<z.infer<typeof codeReviewOutputSchema>>;
export type CodeAuditOutput = ContractShape<z.infer<typeof codeAuditOutputSchema>>;

type OutputFor<C extends StepOutputContractRef> = C extends typeof CODE_REVIEW_OUTPUT_CONTRACT
  ? CodeReviewOutput
  : CodeAuditOutput;
type OutputParseResult<T> =
  { success: true; data: T } | { success: false; issuePaths: readonly string[] };

const MAX_ISSUE_PATHS = 8;
const MAX_ISSUE_PATH_CHARS = 160;

/** Compatibility inspection is safe for old rows too: callers choose their read policy. It
 * never throws on shape mismatch or discloses values in diagnostics. Only new successful
 * writes are checked by the runner; this function does not migrate or backfill stored data. */
export function safeParseStepOutput<C extends StepOutputContractRef>(
  ref: C,
  value: unknown,
  limits: { maxIssues?: number; maxPathChars?: number } = {},
): OutputParseResult<OutputFor<C>> {
  const registered = parseStepOutputContractRef(ref);
  if (!registered) return { success: false, issuePaths: ['$contract'] };
  const validator =
    registered === CODE_REVIEW_OUTPUT_CONTRACT ? codeReviewOutputSchema : codeAuditOutputSchema;
  const result = validator.safeParse(value);
  if (result.success) return { success: true, data: result.data as OutputFor<C> };
  return {
    success: false,
    issuePaths: result.error.issues
      .slice(0, limits.maxIssues ?? MAX_ISSUE_PATHS)
      .map((issue) =>
        (issue.path.map((part) => String(part)).join('.') || '$').slice(
          0,
          limits.maxPathChars ?? MAX_ISSUE_PATH_CHARS,
        ),
      ),
  };
}
