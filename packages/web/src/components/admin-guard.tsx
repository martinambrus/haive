'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { decideAdminAccess } from '@/lib/route-access';

/**
 * Keeps a non-admin out of the admin console's URLs.
 *
 * Client-side for the same reason `ForcedPasswordGuard` is, and the reason is worth repeating
 * because the obvious alternative is a trap: the middleware knows the path but only whether a
 * session COOKIE exists, never the role inside it, while the `(app)` layout knows the role — it
 * already calls /auth/me — and a Server Component cannot learn its own route. Passing the path down
 * from middleware as a request header was tried and MEASURED to break RSC navigation outright.
 *
 * The api's `requireAdmin` remains the actual boundary. This only decides where the browser lands,
 * which is why it is safe for it to be client-side.
 *
 * Children are WITHHELD rather than merely followed by a redirect: `router.replace` is a
 * navigation, so rendering first would flash the admin console at someone who may not have it.
 */
export function AdminGuard({ role, children }: { role: 'admin' | 'user'; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const decision = decideAdminAccess({ path: pathname, role });
  const to = decision.action === 'redirect' ? decision.to : null;

  useEffect(() => {
    // `replace`, not `push`: a page they were never allowed on is not somewhere Back should return.
    if (to) router.replace(to);
  }, [router, to]);

  if (to) return null;
  return <>{children}</>;
}
