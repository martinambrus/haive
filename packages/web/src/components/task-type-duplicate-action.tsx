import Link from 'next/link';
import type { TaskTypeCatalog } from '@/lib/api-client';
import { Button } from './ui';
import { InlineMarkdown } from './markdown/inline-markdown';

export function TaskTypeDuplicateAction({
  slug,
  bases,
}: {
  slug: string;
  bases: TaskTypeCatalog['bases'];
}) {
  const eligibility = bases?.find((base) => base.slug === slug)?.eligibility;
  if (!eligibility) return null;
  return (
    <div>
      {eligibility.eligible ? (
        <Link
          href={`/admin/task-types/new?base=${encodeURIComponent(slug)}`}
          className="inline-flex min-h-11 items-center rounded border border-neutral-600 px-4 text-sm text-neutral-100"
        >
          Duplicate and customize
        </Link>
      ) : (
        <>
          <Button type="button" disabled>
            Duplicate and customize
          </Button>
          <InlineMarkdown
            className="mt-2 max-w-lg text-sm text-amber-300"
            body={eligibility.message}
          />
        </>
      )}
    </div>
  );
}
