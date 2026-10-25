import type { Metadata } from 'next';
import './theme.css';
import './globals.css';
import './connections.css';
import './workbench.css';
import './product.css';
import './review.css';
import SiteHeader from './site-header';
export const metadata: Metadata = {
  title: '共桌 Common Ground · 让协作沉淀为成果',
  description: '在同一份成果中比较观点、回查依据，持续修订。多 AI 协作工作台，本机运行。',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
