import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import type { RuntimeApiConfig } from '@/lib/api-origin';

// Rendered per REQUEST, never prerendered. The whole point of this config is that it comes from
// the environment the container was started with; baking it in at build time would reproduce the
// `NEXT_PUBLIC_API_URL` bug it exists to fix.
export const dynamic = 'force-dynamic';

/** `</script>` inside a JSON string would close the tag that carries it. Escaping `<` is the
 *  standard mitigation and leaves the value byte-identical after JSON.parse. */
function serialiseRuntime(config: RuntimeApiConfig): string {
  return JSON.stringify(config).replace(/</g, '\\u003c');
}

export const metadata: Metadata = {
  title: {
    template: '%s · Haive',
    default: 'Haive',
  },
  description: 'Deterministic multi-CLI orchestration and AI agentic workflow utility',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Read here rather than in the client bundle: `NEXT_PUBLIC_*` is inlined at build time and a
  // published image cannot be told a different port afterwards. These two are ordinary runtime
  // env vars, so the same image serves any install.
  const runtime: RuntimeApiConfig = {
    ...(process.env.HAIVE_PUBLIC_API_URL ? { apiUrl: process.env.HAIVE_PUBLIC_API_URL } : {}),
    ...(process.env.HAIVE_API_PORT ? { apiPort: process.env.HAIVE_API_PORT } : {}),
  };

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before any module script, so `api-client` sees it when it resolves its base URL. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__HAIVE_RUNTIME__=${serialiseRuntime(runtime)}`,
          }}
        />
      </head>
      {/* Extensions (password managers, colour pickers) stamp their own attributes
          onto <body> before React hydrates, and suppressHydrationWarning only covers
          the element it sits on — the one on <html> does not reach here. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
