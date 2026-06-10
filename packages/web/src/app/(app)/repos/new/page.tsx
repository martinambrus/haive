import type { Metadata } from 'next';
import { NewRepoForm } from '@/components/new-repo-form';

export const metadata: Metadata = { title: 'New repository' };

export default function NewRepoPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <NewRepoForm />
    </div>
  );
}
