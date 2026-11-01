'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HaiveDataPanel } from '@/components/repos/haive-data-panel';
import { usePageTitle } from '@/lib/use-page-title';

export default function HaiveDataPage() {
  usePageTitle('Haive data');
  const { id } = useParams<{ id: string }>();
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-5">
      <div>
        <Link href="/repos" className="text-xs text-indigo-300 hover:underline">
          ← Repositories
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-neutral-50">Haive data</h1>
      </div>
      <HaiveDataPanel key={id} repositoryId={id} />
    </div>
  );
}
