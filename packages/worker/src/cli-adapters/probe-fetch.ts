import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { guardedProbeFetch } from '@haive/shared/egress';

export async function resolveProbeFetch(
  db: Database,
  ownerUserId: string,
  handSetBaseUrl: string | null,
): Promise<typeof fetch> {
  // Platform-picked URLs include private sidecars outside the probe allow set.
  if (handSetBaseUrl == null) return fetch;
  const owner = await db.query.users.findFirst({
    where: eq(schema.users.id, ownerUserId),
    columns: { role: true },
  });
  return owner?.role === 'admin' ? fetch : guardedProbeFetch;
}
