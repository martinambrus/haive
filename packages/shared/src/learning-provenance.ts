import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Retain the origin and the last five corrections; older update records are dropped. */
export const LEARNING_UPDATE_HISTORY_MAX = 5;

const stampSchema = z.object({
  taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  date: z.iso.datetime(),
});
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z.object({
  version: z.literal(1),
  origin: z.union([z.literal('unknown'), stampSchema.extend({ bodyHash: hashSchema })]),
  updates: z
    .array(stampSchema.extend({ beforeHash: hashSchema, afterHash: hashSchema }))
    .max(LEARNING_UPDATE_HISTORY_MAX),
});

export type LearningStamp = z.infer<typeof stampSchema>;
export type LearningProvenance = z.infer<typeof provenanceSchema>;

// This namespace is reserved, even in a quoted sample or a malformed/unclosed block.
// A proposed body is content only: it cannot supply a second authoritative record.
const BLOCK = /<!--\s*haive-learning-provenance\b([\s\S]*?)(?:-->|$)/gi;
const WITH_SEPARATOR = /(?:\r?\n){0,2}<!--\s*haive-learning-provenance\b[\s\S]*?(?:-->|$)/gi;

/** Byte-identical on legacy files; a canonical footer strips back to the original final newline. */
export function learningContent(text: string): string {
  let previous: string;
  do {
    previous = text;
    // Removing an inner block can assemble another reserved marker. Every match shrinks text.
    text = text.replace(WITH_SEPARATOR, '');
  } while (text !== previous);
  return text;
}

export function parseLearningRecord(text: string): {
  content: string;
  provenance: LearningProvenance;
} {
  const unknown: LearningProvenance = { version: 1, origin: 'unknown', updates: [] };
  const blocks = [...text.matchAll(BLOCK)];
  const block = blocks.length === 1 ? blocks[0] : undefined;
  let provenance = unknown;
  // Only one complete, trailing record is authoritative. Legacy/malformed records never guess.
  if (
    block &&
    block[0].endsWith('-->') &&
    text.slice(block.index + block[0].length).trim() === ''
  ) {
    try {
      const result = provenanceSchema.safeParse(JSON.parse(block[1]!));
      if (result.success) provenance = result.data;
    } catch {
      // A marker with no supported record is still excluded from learning content.
    }
  }
  return { content: learningContent(text), provenance };
}

function canonicalContent(text: string): string {
  return `${learningContent(text).replace(/\n+$/, '')}\n`;
}

export function renderLearningRecord(content: string, provenance: LearningProvenance): string {
  const checked = provenanceSchema.parse(provenance);
  return `${canonicalContent(content)}\n<!-- haive-learning-provenance\n${JSON.stringify(checked)}\n-->\n`;
}

function bodyHash(text: string): string {
  return createHash('sha256').update(canonicalContent(text), 'utf8').digest('hex');
}

/** The deterministic writer supplies the stamp and trusted prior file, never the proposed body. */
export function stampLearningRecord(
  proposedContent: string,
  priorFile: string | null,
  stamp: LearningStamp,
  historyMax = LEARNING_UPDATE_HISTORY_MAX,
): string {
  if (!Number.isInteger(historyMax) || historyMax < 1 || historyMax > LEARNING_UPDATE_HISTORY_MAX) {
    throw new Error('Invalid learning provenance history limit');
  }
  const checkedStamp = stampSchema.parse(stamp);
  const afterHash = bodyHash(proposedContent);
  const provenance: LearningProvenance =
    priorFile === null
      ? { version: 1, origin: { ...checkedStamp, bodyHash: afterHash }, updates: [] }
      : parseLearningRecord(priorFile).provenance;
  if (priorFile !== null) {
    const beforeHash = bodyHash(priorFile);
    if (beforeHash === afterHash) return priorFile;
    provenance.updates = [
      ...provenance.updates,
      {
        ...checkedStamp,
        beforeHash,
        afterHash,
      },
    ].slice(-historyMax);
  }
  return renderLearningRecord(proposedContent, provenance);
}
