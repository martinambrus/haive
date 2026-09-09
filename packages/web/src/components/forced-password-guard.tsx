'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { decideForcedPasswordChange } from '@/lib/route-access';

/**
 * Holds a user whose password an administrator minted on the page where they can replace it.
 *
 * A client component because the decision needs the PATH and the flag, and no single place has
 * both: the middleware knows the path but not who the visitor is, while the `(app)` layout knows
 * the visitor (it already calls /auth/me) and a Server Component cannot learn its own route.
 * Passing the path down from middleware as a request header was tried and MEASURED to break RSC
 * navigation — see the note on `decideForcedPasswordChange`.
 *
 * Children are WITHHELD rather than merely followed by a redirect: `router.replace` is a
 * navigation, so rendering the page first would flash the content the guard exists to withhold.
 */
export function ForcedPasswordGuard({
  mustChangePassword,
  children,
}: {
  mustChangePassword: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const decision = decideForcedPasswordChange({ path: pathname, mustChangePassword });
  const to = decision.action === 'redirect' ? decision.to : null;

  useEffect(() => {
    // `replace`, not `push`: the page they asked for is not somewhere Back should return to.
    if (to) router.replace(to);
  }, [router, to]);

  if (to) return null;
  return <>{children}</>;
}
