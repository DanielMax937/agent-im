import './globals.css';

import type { ReactNode } from 'react';
import { Noto_Sans_SC } from 'next/font/google';

const notoSansSc = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata = {
  title: 'agent-im 平台',
  description: '基于 Next.js 的 DevOps 智能体与桥接服务',
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN" className={notoSansSc.variable}>
      <body className={notoSansSc.className}>{children}</body>
    </html>
  );
}
