import type { Metadata } from 'next';
import AgentWorkbench from './workbench';
import './agents.css';

export const metadata: Metadata = {
  title: 'AI 协作中转台 · 共桌 Common Ground',
  description: '从执行 AI 粘贴上下文，让多个 API 模型自动分工，再将简报复制回执行 AI。',
};
export default function AgentPage() {
  return <AgentWorkbench />;
}
