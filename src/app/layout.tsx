import './globals.css';

import type { ReactNode } from 'react';

export const metadata = {
  title: 'agent-im 平台',
  description: '基于 Next.js 的 DevOps 智能体与桥接服务',
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
