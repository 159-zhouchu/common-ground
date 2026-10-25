import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './domain';
import { AgentAdviceSchema, agentRoles } from './agent-contract';

export function readStoredJSON<T>(file: string, validate: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validate(value)) throw new Error('Invalid shape');
    return value;
  } catch {
    throw new AppError(
      'STORAGE_CORRUPT',
      `${path.basename(file)} 无法读取或格式损坏；原文件未修改，请按数据恢复说明检查。`,
      503,
    );
  }
}
const price = z.number().finite().nonnegative().nullable();
export const StoredConnection = z
  .object({
    label: z.string(),
    baseURL: z.string(),
    apiKey: z.string(),
    model: z.string(),
    protocol: z.enum(['chat', 'responses']),
    structured: z.boolean(),
    inputPrice: price,
    outputPrice: price,
  })
  .passthrough();
export const ConnectionList = z.object({
  version: z.literal(2),
  connections: z.array(StoredConnection.extend({ connectionId: z.string(), enabled: z.boolean() })),
});
export const LegacyConnectionList = z.array(StoredConnection.extend({ slot: z.enum(['a', 'b']) }));
export const StoredConnectionTests = z.array(
  z
    .object({
      id: z.string(),
      model: z.string(),
      baseURL: z.string(),
      protocol: z.string(),
      startedAt: z.string(),
      latencyMs: z.number(),
      success: z.boolean(),
      input: price,
      output: price,
      cost: price,
    })
    .passthrough(),
);
export const StoredAgentJobs = z.array(
  z
    .object({
      id: z.string(),
      requestHash: z.string(),
      goal: z.string(),
      budget: price,
      createdAt: z.string(),
      result: AgentAdviceSchema.optional(),
      phase: z.enum(['plan', 'review']),
      state: z.enum(['running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']),
      decision: z.enum(['pending', 'ready', 'needs_input', 'incomplete']),
      context: z.array(z.object({ name: z.string(), content: z.string() })),
      steps: z.array(
        z
          .object({
            role: z.enum(agentRoles),
            state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
            connection: StoredConnection.omit({ apiKey: true }).extend({
              connectionId: z.string(),
              updatedAt: z.string().nullable(),
            }),
            sent: z.boolean(),
            cost: price,
            output: AgentAdviceSchema.optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
);
