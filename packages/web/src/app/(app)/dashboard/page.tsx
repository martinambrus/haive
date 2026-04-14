import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, Button } from '@/components/ui';

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Dashboard</h1>
        <p className="text-sm text-neutral-400">
          Phase 2 scaffold. Auth and repository management are wired; tasks land in Phase 5.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
            <CardDescription>Connect a local checkout or clone from GitHub/GitLab.</CardDescription>
          </CardHeader>
          <Link href="/repos">
            <Button variant="secondary" size="sm">
              Manage repositories
            </Button>
          </Link>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
            <CardDescription>
              Run deterministic onboarding and workflow step engines.
            </CardDescription>
          </CardHeader>
          <Link href="/tasks">
            <Button variant="secondary" size="sm">
              Manage tasks
            </Button>
          </Link>
        </Card>
      </div>
    </div>
  );
}
