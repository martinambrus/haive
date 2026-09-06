import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: {
    template: '%s · Haive',
    default: 'Haive',
  },
  description: 'Deterministic multi-CLI orchestration and AI agentic workflow utility',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* Extensions (password managers, colour pickers) stamp their own attributes
          onto <body> before React hydrates, and suppressHydrationWarning only covers
          the element it sits on — the one on <html> does not reach here. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
