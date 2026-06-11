import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { globalKbEntries, withGlobalKb, type GlobalKbFacets } from '@haive/shared/global-kb';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { extractFencedJson } from '../_fenced-json.js';

// Repo-anchored global-KB enrichment (plan §5.1/§5.3). The task is created by the
// global-kb enrich endpoint with a repositoryId + cliProviderId and
// metadata.globalKbEntryId pointing at a `skeleton` entry. The generic task
// machinery mounts the repo into the sandbox and dispatches the chosen CLI when
// this step's llm phase runs, so the model can READ the repo's module code and
// extract real examples + the MAJOR version. The result lands as a `draft` the
// user reviews + activates in Settings → Global KB. Form-less: detect → llm →
// apply, hands-free (mirrors 01-env-detect).

interface KbAuthorDetect {
  entryId: string | null;
  title: string;
  seedText: string;
  facets: GlobalKbFacets;
}

interface KbAuthorApply {
  entryId: string | null;
  status: 'draft' | 'skipped';
  sections: number;
}

const FACET_DIMS = [
  'framework',
  'frameworkMajor',
  'language',
  'phpMajor',
  'nodeMajor',
  'packages',
  'tags',
] as const;

async function loadEntryId(ctx: StepContext): Promise<string | null> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { metadata: true },
  });
  const md = task?.metadata as { globalKbEntryId?: string } | null;
  return md?.globalKbEntryId ?? null;
}

function buildEnrichPrompt(detected: KbAuthorDetect): string {
  const stack = FACET_DIMS.map((d) => {
    const v = detected.facets[d];
    return Array.isArray(v) && v.length ? `${d}: ${v.join(', ')}` : '';
  })
    .filter(Boolean)
    .join('; ');
  return [
    'You are documenting a reusable house standard for a global, cross-project knowledge base.',
    "You are running inside a sandbox with THIS project's repository checked out at the current",
    'working directory. You have file tools to read it, and — only if network egress is permitted —',
    'web access. Do not assume internet access; if a fetch fails, rely on the repository alone.',
    '',
    '## Title',
    detected.title,
    '',
    '## Target stack (from the author)',
    stack || '(unspecified)',
    '',
    '## Skeleton to expand into a complete, concrete entry',
    detected.seedText || '(empty — derive the topic from the title)',
    '',
    '## Your task',
    '1. READ the relevant module / library / code in THIS repository that the skeleton refers to.',
    '   Cite real file paths and copy concrete, working examples (config, code) from the repo — not',
    '   generic advice.',
    '2. Determine the MAJOR version of the framework and any relevant module from the repo manifests',
    '   (composer.json drupal/core, package.json, lockfiles). MAJOR versions only (e.g. 11, not 11.2).',
    '3. If you have web access, research the official documentation / module README to fill gaps and',
    '   add accurate usage. If you have no web access, rely on the repository only.',
    '4. Produce a complete, self-contained markdown article another engineer could follow.',
    '',
    '## Output — emit EXACTLY ONE fenced ```json block and nothing else:',
    '```json',
    '{',
    '  "body": "<the full markdown article>",',
    '  "facets": {',
    '    "framework": ["<e.g. drupal>"],',
    '    "frameworkMajor": ["<e.g. 11>"],',
    '    "language": ["<e.g. php>"],',
    '    "packages": ["<name@major, e.g. drupal/paragraphs@8>"]',
    '  }',
    '}',
    '```',
    'Set facets to the versions you actually found in the repository. Omit a dimension that does not',
    'apply. Major versions only.',
  ].join('\n');
}

function parseEnrichment(raw: unknown): { body?: string; facets?: GlobalKbFacets } | null {
  let text: string | null = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.body === 'string') return { body: o.body, facets: o.facets as GlobalKbFacets };
    if (typeof o.result === 'string') text = o.result;
    else if (typeof o.text === 'string') text = o.text;
    else text = JSON.stringify(o);
  }
  if (!text) return null;
  const json = extractFencedJson(text) ?? text;
  try {
    return JSON.parse(json) as { body?: string; facets?: GlobalKbFacets };
  } catch {
    return null;
  }
}

/** Author facets are the intent; the LLM read the actual repo, so its values win
 *  per dimension when present, otherwise keep the author's. */
function mergeFacets(seed: GlobalKbFacets, llm?: GlobalKbFacets): GlobalKbFacets {
  const out: GlobalKbFacets = {};
  for (const d of FACET_DIMS) {
    const l = llm?.[d];
    const s = seed?.[d];
    const v = Array.isArray(l) && l.length ? l : s;
    if (Array.isArray(v) && v.length) {
      out[d] = [...new Set(v.filter((x) => typeof x === 'string' && x).map(String))];
    }
  }
  return out;
}

export const kbAuthorEnrichStep: StepDefinition<KbAuthorDetect, KbAuthorApply> = {
  metadata: {
    id: '01-kb-enrich',
    workflowType: 'kb_author',
    index: 0,
    title: 'Knowledge base enrichment',
    description:
      'Expands a skeleton into a version-scoped global KB draft by reading the chosen repository (and, if egress allows, online docs) with a chosen CLI.',
    requiresCli: true,
  },

  async detect(ctx): Promise<KbAuthorDetect> {
    const entryId = await loadEntryId(ctx);
    if (!entryId) throw new Error('kb_author task is missing metadata.globalKbEntryId');
    const entry = await withGlobalKb(ctx.db, async ({ db }) =>
      db.query.globalKbEntries.findFirst({ where: eq(globalKbEntries.id, entryId) }),
    );
    if (!entry) throw new Error(`global KB entry ${entryId} not found`);
    await withGlobalKb(ctx.db, async ({ db }) => {
      await db
        .update(globalKbEntries)
        .set({ status: 'enriching', updatedAt: new Date() })
        .where(eq(globalKbEntries.id, entryId));
    });
    return {
      entryId,
      title: entry.title,
      seedText: entry.seedText ?? entry.body,
      facets: entry.facets ?? {},
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt: (args) => buildEnrichPrompt(args.detected as KbAuthorDetect),
    timeoutMs: 30 * 60 * 1000,
    bypassStub: (args) => {
      const d = args.detected as KbAuthorDetect;
      return { body: `# ${d.title}\n\n${d.seedText}`, facets: d.facets };
    },
  },

  async apply(ctx, args): Promise<KbAuthorApply> {
    const detected = args.detected as KbAuthorDetect;
    if (!detected.entryId) return { entryId: null, status: 'skipped', sections: 0 };

    const parsed = parseEnrichment(args.llmOutput ?? null);
    const body =
      parsed?.body && parsed.body.trim().length > 0
        ? parsed.body
        : `# ${detected.title}\n\n${detected.seedText}`;
    const facets = mergeFacets(detected.facets, parsed?.facets);

    await withGlobalKb(ctx.db, async ({ db }) => {
      await db
        .update(globalKbEntries)
        .set({ body, facets, status: 'draft', embedStatus: 'pending', updatedAt: new Date() })
        .where(eq(globalKbEntries.id, detected.entryId!));
    });

    ctx.logger.info(
      { entryId: detected.entryId, enriched: !!parsed?.body },
      'kb enrichment complete → draft',
    );
    return {
      entryId: detected.entryId,
      status: 'draft',
      sections: (body.match(/^##\s/gm) ?? []).length,
    };
  },
};
