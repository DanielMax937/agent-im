import './globals.css';

import type { ReactNode } from 'react';

export const metadata = {
  title: 'agent-im platform',
  description: 'Next.js DevOps agentic platform server',
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
