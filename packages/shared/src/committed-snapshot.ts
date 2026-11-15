import { z } from 'zod';

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Host-issued identity only. Paths and inventory bodies are resolved by the host, never
 * accepted from an agent. Parsing validates the wire shape; it does not grant authority or
 * prove the objects/inventory exist. A consumer must verify ownership and content separately. */
export const committedSnapshotRefSchema = z
  .object({
    version: z.literal(1),
    userId: z.uuid(),
    repositoryId: z.uuid(),
    taskId: z.uuid(),
    commitOid: objectId,
    treeOid: objectId,
    inventoryId: z.uuid(),
    inventorySha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine((ref) => ref.commitOid.length === ref.treeOid.length);

export type CommittedSnapshotRef = z.infer<typeof committedSnapshotRefSchema>;

export function parseCommittedSnapshotRef(value: unknown): CommittedSnapshotRef {
  const result = committedSnapshotRefSchema.safeParse(value);
  // Stored JSON can contain arbitrary paths or secrets. Never put its values in an error.
  if (!result.success) throw new Error('Invalid committed snapshot reference');
  return result.data;
}

export function serializeCommittedSnapshotRef(value: unknown): string {
  return JSON.stringify(parseCommittedSnapshotRef(value));
}

/** NULL/absent is the legacy live-checkout contract. A diff base requires a target in the
 * same ownership scope. No coercion or fallback is allowed for non-null stored data. */
export function parseCommittedSnapshotRefs(value: {
  snapshotRef?: unknown;
  baseSnapshotRef?: unknown;
}): { snapshotRef: CommittedSnapshotRef | null; baseSnapshotRef: CommittedSnapshotRef | null } {
  const snapshotRef =
    value.snapshotRef == null ? null : parseCommittedSnapshotRef(value.snapshotRef);
  const baseSnapshotRef =
    value.baseSnapshotRef == null ? null : parseCommittedSnapshotRef(value.baseSnapshotRef);
  if (
    baseSnapshotRef &&
    (!snapshotRef ||
      baseSnapshotRef.userId !== snapshotRef.userId ||
      baseSnapshotRef.repositoryId !== snapshotRef.repositoryId ||
      baseSnapshotRef.taskId !== snapshotRef.taskId ||
      baseSnapshotRef.commitOid.length !== snapshotRef.commitOid.length)
  ) {
    throw new Error('Invalid committed snapshot target/base pairing');
  }
  return { snapshotRef, baseSnapshotRef };
}
