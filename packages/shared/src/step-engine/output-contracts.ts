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
export const SPEC_DRAFT_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.spec.draft',
  version: 1,
} as const);
export const SPEC_CHECKED_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.spec.checked',
  version: 1,
} as const);
export const SPEC_RESOLVED_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.spec.resolved',
  version: 1,
} as const);

export const DISCOVERY_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.discovery',
  version: 1,
} as const);
export const REQUIREMENTS_DRAFT_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.requirements.draft',
  version: 1,
} as const);
export const REQUIREMENTS_HUMANIZED_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.requirements.humanized',
  version: 1,
} as const);
export const IMPLEMENTATION_SUMMARY_OUTPUT_CONTRACT = Object.freeze({
  id: 'haive.implementation.summary',
  version: 1,
} as const);
export const CHECK_RESULT_ROLES = Object.freeze({
  validation: 'haive.validation',
  verify: 'haive.verify',
  testManagement: 'haive.test-management',
} as const);
export const VALIDATION_OUTPUT_CONTRACT = Object.freeze({
  id: CHECK_RESULT_ROLES.validation,
  version: 1,
} as const);
export const VERIFY_OUTPUT_CONTRACT = Object.freeze({
  id: CHECK_RESULT_ROLES.verify,
  version: 1,
} as const);
export const TEST_MANAGEMENT_OUTPUT_CONTRACT = Object.freeze({
  id: CHECK_RESULT_ROLES.testManagement,
  version: 1,
} as const);
export type CheckResultRole = (typeof CHECK_RESULT_ROLES)[keyof typeof CHECK_RESULT_ROLES];

export const IMPLEMENTATION_SUMMARY_ROLE = 'haive.implementation.summary' as const;
export const IMPLEMENTATION_SUMMARY_DAG_STEP_ID = '06c-dag-execute' as const;

export const DISCOVERY_ROLE = 'haive.discovery' as const;
export const REQUIREMENTS_ROLES = Object.freeze({
  draft: 'haive.requirements.draft',
  humanized: 'haive.requirements.humanized',
} as const);

/** Frozen v1/v2 aliases. Do not extend this set: those pins support review/audit only. */
export const STEP_ROLES = Object.freeze({
  codeReview: '08c-code-review',
  codeAudit: '08c2-code-audit',
} as const);
export type LegacyStepRoleId = (typeof STEP_ROLES)[keyof typeof STEP_ROLES];
export const SPEC_ROLES = Object.freeze({
  draft: 'haive.spec.draft',
  checked: 'haive.spec.checked',
  resolved: 'haive.spec.resolved',
} as const);

export type SpecRoleId = (typeof SPEC_ROLES)[keyof typeof SPEC_ROLES];

/** Host-owned data ports. A port grants no routing, replacement or quotation authority.
 * Physical review/audit role ids remain aliases for the exact original contracts. */
export const STEP_ROLE_REGISTRY = Object.freeze({
  [STEP_ROLES.codeReview]: Object.freeze({
    id: STEP_ROLES.codeReview,
    contract: CODE_REVIEW_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'agent',
    quoteProjection: 'agent',
    legacyStepId: STEP_ROLES.codeReview,
    hostPolicy: 'code-review',
  } as const),
  [STEP_ROLES.codeAudit]: Object.freeze({
    id: STEP_ROLES.codeAudit,
    contract: CODE_AUDIT_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'agent',
    quoteProjection: 'agent',
    legacyStepId: STEP_ROLES.codeAudit,
    hostPolicy: 'code-audit',
  } as const),
  [CHECK_RESULT_ROLES.validation]: Object.freeze({
    id: CHECK_RESULT_ROLES.validation,
    contract: VALIDATION_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '07b-phase-4-validate',
  } as const),
  [CHECK_RESULT_ROLES.verify]: Object.freeze({
    id: CHECK_RESULT_ROLES.verify,
    contract: VERIFY_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '08-phase-5-verify',
  } as const),
  [CHECK_RESULT_ROLES.testManagement]: Object.freeze({
    id: CHECK_RESULT_ROLES.testManagement,
    contract: TEST_MANAGEMENT_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '08b-test-management',
  } as const),
  // 07's salvage/bypass stubs and the DAG compatibility adapter write host text.
  // Module producers cannot strengthen this whole-role authorship guarantee.
  [IMPLEMENTATION_SUMMARY_ROLE]: Object.freeze({
    id: IMPLEMENTATION_SUMMARY_ROLE,
    contract: IMPLEMENTATION_SUMMARY_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '07-phase-2-implement',
  } as const),
  // Discovery's stub copies operator/repository text; its normal aggregate also adds
  // host headings and coverage notes. No agent-only projection covers every path.
  [DISCOVERY_ROLE]: Object.freeze({
    id: DISCOVERY_ROLE,
    contract: DISCOVERY_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '03-phase-0a-discovery',
  } as const),
  // Draft parsing defaults and bypass/final-attempt fallbacks write host text.
  [REQUIREMENTS_ROLES.draft]: Object.freeze({
    id: REQUIREMENTS_ROLES.draft,
    contract: REQUIREMENTS_DRAFT_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '03b-business-requirements',
  } as const),
  // Humanization can pass through that draft, including an alternate module's data.
  [REQUIREMENTS_ROLES.humanized]: Object.freeze({
    id: REQUIREMENTS_ROLES.humanized,
    contract: REQUIREMENTS_HUMANIZED_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '03b2-humanize-requirements',
  } as const),
  [SPEC_ROLES.draft]: Object.freeze({
    id: SPEC_ROLES.draft,
    contract: SPEC_DRAFT_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '04-phase-0b-pre-planning',
  } as const),
  [SPEC_ROLES.checked]: Object.freeze({
    id: SPEC_ROLES.checked,
    contract: SPEC_CHECKED_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '05-phase-0b5-spec-quality',
  } as const),
  [SPEC_ROLES.resolved]: Object.freeze({
    id: SPEC_ROLES.resolved,
    contract: SPEC_RESOLVED_OUTPUT_CONTRACT,
    cardinality: 'one',
    authorship: 'mixed',
    legacyStepId: '05a-resolve-spec-warnings',
  } as const),
});
export type StepRoleId = keyof typeof STEP_ROLE_REGISTRY;
export type DataStepRoleId = Exclude<StepRoleId, LegacyStepRoleId>;
export type StepOutputContractRef = (typeof STEP_ROLE_REGISTRY)[StepRoleId]['contract'];
/** The ONLY ports with executable host policy. New data roles must never enter that branch. */
export const HOST_POLICY_STEP_ROLES: readonly LegacyStepRoleId[] = Object.freeze(
  Object.values(STEP_ROLE_REGISTRY)
    .filter((entry) => 'hostPolicy' in entry)
    .map((entry) => entry.id as LegacyStepRoleId),
);
export function stepRoleOutputContract<R extends StepRoleId>(
  role: R,
): (typeof STEP_ROLE_REGISTRY)[R]['contract'] {
  return STEP_ROLE_REGISTRY[role].contract;
}

/** Exact id + version, with no module-supplied validator or compatibility assertion. */
export function parseStepOutputContractRef(value: unknown): StepOutputContractRef | null {
  const ref = parseRegistryOutputContractRef(value);
  return ref && HOST_POLICY_STEP_ROLES.some((role) => STEP_ROLE_REGISTRY[role].contract === ref)
    ? ref
    : null;
}

/** Exact data-role reference lookup. Executable outputContract/replaces and v1/v2 pins
 * retain the restricted parseStepOutputContractRef gate. */
export function parseRegistryOutputContractRef(value: unknown): StepOutputContractRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).length !== 2 || !Object.hasOwn(ref, 'id') || !Object.hasOwn(ref, 'version'))
    return null;
  return (
    Object.values(STEP_ROLE_REGISTRY).find(
      ({ contract }) => contract.id === ref.id && contract.version === ref.version,
    )?.contract ?? null
  );
}

export function stepOutputContractsEqual(expected: unknown, actual: unknown): boolean {
  const ref = parseStepOutputContractRef(expected);
  return ref !== null && ref === parseStepOutputContractRef(actual);
}

// Schemas and validator registry stay private: publishing a Zod object would let a consumer mutate its
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

// Minimum consumer fields only. Unknown storage extensions survive validation; no defaults
// or coercion. Optional fields accommodate rows written before those fields were introduced.
const specFindingSchema = z
  .object({
    dimension: z.string().optional(),
    severity: z.string().optional(),
    comment: z.string().optional(),
  })
  .passthrough();
const affectedComponentsSchema = z
  .object({
    named: z.array(
      z
        .object({ id: z.string(), title: z.string(), parentTitle: z.string().nullable() })
        .passthrough(),
    ),
    reached: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          depth: z.number(),
          via: z.string(),
          reversed: z.boolean().optional(),
        })
        .passthrough(),
    ),
    truncated: z
      .object({ reason: z.enum(['depth', 'nodes']), limit: z.number() })
      .passthrough()
      .nullable(),
    diagrams: z
      .array(
        z.object({ depth: z.number(), mermaid: z.string(), omitted: z.number() }).passthrough(),
      )
      .optional(),
    namedOmitted: z.number().optional(),
  })
  .passthrough();
const specDraftOutputSchema = z
  .object({
    spec: z.string(),
    summary: z.string().optional(),
    affectedComponents: affectedComponentsSchema.optional(),
  })
  .passthrough();
const specCheckedOutputSchema = z
  .object({
    spec: z.string(),
    verdict: z.string().optional(),
    score: z.number().optional(),
    findings: z.array(specFindingSchema).optional(),
    scopeQuestions: z.array(z.string()).optional(),
    amendmentDiscarded: z
      .object({
        amendedLength: z.number().optional(),
        currentLength: z.number().optional(),
        headings: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const specResolvedOutputSchema = z
  .object({ spec: z.string(), scopeQuestions: z.array(z.string()).optional() })
  .passthrough();
export type SpecDraftOutput = ContractShape<z.infer<typeof specDraftOutputSchema>>;
export type SpecCheckedOutput = ContractShape<z.infer<typeof specCheckedOutputSchema>>;
export type SpecResolvedOutput = ContractShape<z.infer<typeof specResolvedOutputSchema>>;

const discoveryOutputSchema = z
  .object({
    summary: z.string(),
    relevantKbIds: z.array(z.string()),
    source: z.string().optional(),
  })
  .passthrough();
const requirementsOutputSchema = z
  .object({ requirements: z.string(), summary: z.string() })
  .passthrough();
export type DiscoveryOutput = ContractShape<z.infer<typeof discoveryOutputSchema>>;
export type RequirementsOutput = ContractShape<z.infer<typeof requirementsOutputSchema>>;

const implementationSummaryOutputSchema = z
  .object({
    summary: z.string(),
    filesTouched: z.array(z.string()),
    similarSites: z
      .array(
        z
          .object({
            path: z.string(),
            lines: z.string().optional(),
            reason: z.string(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type ImplementationSummaryOutput = ContractShape<
  z.infer<typeof implementationSummaryOutputSchema>
>;

// Explicit outcome states are independent of the physical producer's lifecycle.
// A successful write can truthfully report an incomplete or unexecuted check.
const resultStatusSchema = z.enum([
  'not-run',
  'skipped',
  'incomplete',
  'failed',
  'passed',
  'manual',
  'declined',
]);
const resultCoverageSchema = z
  .object({ listed: z.number(), total: z.number(), scanFailed: z.literal(true).optional() })
  .passthrough();
const validationOutputSchema = z
  .object({
    resultStatus: resultStatusSchema.exclude(['manual', 'declined']),
    exhaustedBudget: z.boolean(),
    verdict: z.enum(['VALID', 'ISSUES_FOUND', 'UNPARSEABLE']),
    summary: z.string(),
    issues: z.array(
      z
        .object({
          upstream: z.enum(['infrastructure', 'dependency', 'unknown']).nullable().optional(),
          severity: z.enum(REVIEW_SEVERITIES),
          file: z.string().optional(),
          description: z.string(),
          fix: z.string().optional(),
          rule: z.string().optional(),
        })
        .passthrough(),
    ),
    dimensions: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(['PASS', 'FAIL', 'N/A']),
          note: z.string().optional(),
        })
        .passthrough(),
    ),
    excludedDimensions: z.array(z.string()),
    fixesApplied: z.array(z.string()),
    converged: z.boolean(),
    churnFiles: z.array(z.string()),
    report: z.string(),
    reportChars: z.number().optional(),
    validatorPasses: z.number(),
    validatorInvocationId: z.string().nullable().optional(),
    changeFingerprint: z.string().optional(),
    changedFilesCoverage: resultCoverageSchema.optional(),
    ruleConflicts: z
      .array(
        z
          .object({ rule: z.string(), file: z.string().optional(), reason: z.string() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .superRefine((o, ctx) => {
    if (
      o.resultStatus === 'passed' &&
      (o.verdict !== 'VALID' ||
        o.exhaustedBudget ||
        !o.converged ||
        o.issues.length ||
        o.dimensions.some((d) => d.status === 'FAIL') ||
        o.changedFilesCoverage?.scanFailed ||
        (o.changedFilesCoverage && o.changedFilesCoverage.listed < o.changedFilesCoverage.total))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['resultStatus'],
        message: 'passing validation requires complete valid evidence',
      });
  });
const checkSlotSchema = z
  .object({
    ran: z.boolean(),
    passed: z.boolean(),
    command: z.string().nullable(),
    output: z.string(),
    note: z.string().optional(),
    scope: z.object({ blocking: z.number(), preExisting: z.number() }).passthrough().optional(),
  })
  .passthrough();
const slotNameSchema = z.enum(['test', 'lint', 'typecheck']);
const verifyOutputSchema = z
  .object({
    resultStatus: resultStatusSchema,
    test: checkSlotSchema,
    lint: checkSlotSchema,
    phpLint: checkSlotSchema.optional(),
    typecheck: checkSlotSchema,
    passed: z.boolean(),
    declinedConfigs: z.array(z.string()),
    declaredSlots: z.array(slotNameSchema),
    offSlots: z.array(slotNameSchema),
    slotWithoutRunner: z.boolean(),
    runtimeSmoke: z
      .object({
        ran: z.boolean(),
        passed: z.boolean().nullable(),
        httpStatus: z.number().nullable(),
        url: z.string().nullable(),
        errorExcerpt: z.string(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough()
  .superRefine((o, ctx) => {
    const checks = [o.test, o.lint, o.phpLint, o.typecheck].filter((v) => v !== undefined);
    if (
      o.resultStatus === 'passed' &&
      (!o.passed || !checks.some((c) => c.ran) || checks.some((c) => c.ran && !c.passed))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['resultStatus'],
        message: 'passing verification requires executed checks',
      });
  });
const testManagementOutputSchema = z
  .object({
    resultStatus: resultStatusSchema.exclude(['manual', 'declined']),
    action: z.string(),
    testsCreated: z.array(z.string()),
    testsUpdated: z.array(z.string()),
    testsDeleted: z.array(z.string()),
    testsPassed: z.boolean().nullable(),
    primary: z
      .enum([
        'playwright',
        'cypress',
        'vitest',
        'jest',
        'phpunit',
        'pytest',
        'pkg-script',
        'composer-script',
      ])
      .nullable(),
  })
  .passthrough()
  .superRefine((o, ctx) => {
    if (o.resultStatus === 'passed' && (o.testsPassed !== true || o.action === 'skip'))
      ctx.addIssue({
        code: 'custom',
        path: ['resultStatus'],
        message: 'passing test management requires executed tests',
      });
  });
export type ValidationOutput = ContractShape<z.infer<typeof validationOutputSchema>>;
export type VerifyResultOutput = ContractShape<z.infer<typeof verifyOutputSchema>>;
export type TestManagementOutput = ContractShape<z.infer<typeof testManagementOutputSchema>>;

const outputValidators = Object.freeze({
  'haive.validation': validationOutputSchema,
  'haive.verify': verifyOutputSchema,
  'haive.test-management': testManagementOutputSchema,
  'haive.implementation.summary': implementationSummaryOutputSchema,
  'haive.discovery': discoveryOutputSchema,
  'haive.requirements.draft': requirementsOutputSchema,
  'haive.requirements.humanized': requirementsOutputSchema,
  'haive.code-review': codeReviewOutputSchema,
  'haive.code-audit': codeAuditOutputSchema,
  'haive.spec.draft': specDraftOutputSchema,
  'haive.spec.checked': specCheckedOutputSchema,
  'haive.spec.resolved': specResolvedOutputSchema,
});
export type OutputFor<C extends StepOutputContractRef> = ContractShape<
  z.infer<(typeof outputValidators)[C['id']]>
>;
export type RoleOutput<R extends StepRoleId> = OutputFor<
  (typeof STEP_ROLE_REGISTRY)[R]['contract']
>;

/** Only the declared fields of an explicitly agent-only projection may be quoted.
 * Passthrough storage keys carry no authorship guarantee. */
export function isQuotableRole(role: unknown): role is StepRoleId {
  if (typeof role !== 'string' || !Object.hasOwn(STEP_ROLE_REGISTRY, role)) return false;
  const quoteEntry = STEP_ROLE_REGISTRY[role as StepRoleId];
  return (
    quoteEntry.authorship === 'agent' &&
    'quoteProjection' in quoteEntry &&
    quoteEntry.quoteProjection === 'agent'
  );
}

/** Prompt producers must carry neither host policy nor human/mixed authorship. */
export function isPromptProvidableRole(role: unknown): role is StepRoleId {
  return isQuotableRole(role) && !('hostPolicy' in STEP_ROLE_REGISTRY[role]);
}

/** A fresh JSON schema, never the mutable validator instance. */
export function stepOutputJsonSchema(ref: StepOutputContractRef): Record<string, unknown> {
  const registered = parseRegistryOutputContractRef(ref);
  if (!registered) throw new Error('unknown host data contract');
  return z.toJSONSchema(outputValidators[registered.id]);
}

/** Explicit legacy read projection: do not expose storage extensions to port consumers.
 * Does not validate or rewrite malformed historical fields; readiness is reported separately. */
export function projectRoleOutput<R extends StepRoleId>(
  role: R,
  value: unknown,
): Partial<RoleOutput<R>> | null {
  if (value == null) return null;
  const validator = outputValidators[stepRoleOutputContract(role).id];
  return projectDeclared(value, validator) as Partial<RoleOutput<R>>;
}
function projectDeclared(value: unknown, validator: z.ZodType): unknown {
  if (value == null) return value;
  if (validator instanceof z.ZodOptional || validator instanceof z.ZodNullable)
    return projectDeclared(value, validator.unwrap() as z.ZodType);
  if (validator instanceof z.ZodObject && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(validator.shape)
        .filter(([key]) => Object.hasOwn(input, key))
        .map(([key, field]) => [key, projectDeclared(input[key], field as z.ZodType)]),
    );
  }
  if (validator instanceof z.ZodArray && Array.isArray(value))
    return value.map((item) => projectDeclared(item, validator.element as z.ZodType));
  return value;
}
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
  const registered = parseRegistryOutputContractRef(ref);
  if (!registered) return { success: false, issuePaths: ['$contract'] };
  const validator = outputValidators[registered.id];
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
