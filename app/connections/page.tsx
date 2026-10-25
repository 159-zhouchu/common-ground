import type { Metadata } from 'next';
import ConnectionEditor from '../connection-editor';

export const metadata: Metadata = { title: 'API 接入 · 共桌 Common Ground' };
export default function ConnectionsPage() {
  return (
    <main className="api-page" id="main-content" tabIndex={-1}>
      <div className="site-page-meta">
        <span>工作空间 / 模型连接</span>
        <span>连接一次，按任务分工</span>
      </div>
      <ConnectionEditor />
    </main>
  );
}
