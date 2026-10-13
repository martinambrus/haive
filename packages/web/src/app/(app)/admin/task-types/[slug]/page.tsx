'use client';

import { useParams } from 'next/navigation';
import { TaskTypeEditor } from '@/components/task-type-editor';

export default function TaskTypePage() {
  const params = useParams<{ slug: string }>();
  return <TaskTypeEditor key={params.slug} slug={params.slug} />;
}
