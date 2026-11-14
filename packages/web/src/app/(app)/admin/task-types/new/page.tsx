'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { TaskTypeEditor } from '@/components/task-type-editor';

function NewTaskTypeEditor() {
  const params = useSearchParams();
  return <TaskTypeEditor slug={null} duplicateBaseSlug={params.get('base')} />;
}

export default function NewTaskTypePage() {
  return (
    <Suspense>
      <NewTaskTypeEditor />
    </Suspense>
  );
}
