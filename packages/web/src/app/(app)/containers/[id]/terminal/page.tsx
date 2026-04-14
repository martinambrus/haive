'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Terminal } from '@/components/terminal/Terminal';

export default function ContainerTerminalPage() {
  const params = useParams<{ id: string }>();
  const containerId = params.id;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/dashboard" className="text-xs text-neutral-500 hover:text-neutral-300">
          Back to dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-neutral-50">Container terminal</h1>
        <p className="text-sm text-neutral-400">
          Live shell attached via dockerode. Ctrl+C/D are trapped client-side; toggle forwarding to
          send them to the container process.
        </p>
        <p className="mt-1 font-mono text-xs text-neutral-500">{containerId}</p>
      </div>
      <Terminal containerId={containerId} />
    </div>
  );
}
