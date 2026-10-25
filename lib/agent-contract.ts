import { z } from 'zod';
import type { ConnectionSnapshot, Step } from './types';

export const agentRoles = ['planner', 'analyst', 'reviewer', 'synthesizer'] as const;
export type AgentRole = (typeof agentRoles)[number];
export const agentRoleNames: Record<AgentRole, string> = {
  planner: '任务规划',
  analyst: '实现分析',
  reviewer: '风险审查',
  synthesizer: '执行简报',
};
export const AgentRequestSchema = z
  .object({
    idempotencyKey: z.uuid(),
    goal: z.string().trim().min(1).max(12000),
    phase: z.enum(['plan', 'review']).default('plan'),
    context: z
      .array(
        z
          .object({ name: z.string().trim().min(1).max(300), content: z.string().max(60000) })
          .strict(),
      )
      .max(20)
      .default([]),
    roles: z
      .object({
        planner: z.string().min(1).max(100),
        analyst: z.string().min(1).max(100),
        reviewer: z.string().min(1).max(100),
        synthesizer: z.string().min(1).max(100),
      })
      .strict(),
    budget: z.number().positive().max(100).nullable().default(null),
  })
  .strict();
export const AgentAdviceSchema = z
  .object({
    summary: z.string().trim().min(1).max(12000),
    steps: z
      .array(
        z
          .object({
            task: z.string().max(2000),
            files: z.array(z.string().max(300)).max(20),
            checks: z.array(z.string().max(1000)).max(12),
          })
          .strict(),
      )
      .max(12),
    risks: z.array(z.string().max(2000)).max(12),
    questions: z.array(z.string().max(2000)).max(12),
    ready: z.boolean(),
  })
  .strict();
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentAdvice = z.infer<typeof AgentAdviceSchema>;
export type AgentStep = {
  diagnostic?: Step['diagnostic'];
  role: AgentRole;
  connection: ConnectionSnapshot;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  sent: boolean;
  inputHash?: string;
  startedAt?: string;
  endedAt?: string;
  output?: AgentAdvice;
  error?: string;
  cost: number | null;
  usage?: { input: number | null; output: number | null };
  requestId?: string;
};
export type AgentJob = {
  archivedAt?: string;
  id: string;
  requestHash: string;
  goal: string;
  phase: AgentRequest['phase'];
  context: AgentRequest['context'];
  budget: number | null;
  createdAt: string;
  endedAt?: string;
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  steps: AgentStep[];
  result?: AgentAdvice;
  decision: 'pending' | 'ready' | 'needs_input' | 'incomplete';
  error?: string;
};
