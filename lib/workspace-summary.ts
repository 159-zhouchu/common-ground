import type { Store, Task, Run } from './types';

export type TaskSummary = Pick<
  Task,
  'id' | 'title' | 'example' | 'currentRevision' | 'createdAt' | 'updatedAt'
> & {
  revisionCount: number;
  sourceCount: number;
  findingCount: number;
  runCount: number;
  runs: Pick<Run, 'id' | 'state'>[];
};
export type WorkspaceSummary = {
  version: 1;
  tasks: TaskSummary[];
  archivedTasks: Pick<Task, 'id' | 'title'>[];
};

// Explicit allowlist: list polling must never acquire document or model-result text.
export function taskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    example: task.example,
    currentRevision: task.currentRevision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    revisionCount: task.revisions.length,
    sourceCount: task.sources.length,
    findingCount: task.findings.length,
    runCount: task.runs.length,
    runs: task.runs.map(({ id, state }) => ({ id, state })),
  };
}
export function workspaceSummary(store: Store): WorkspaceSummary {
  return {
    version: store.version,
    tasks: store.tasks.map(taskSummary),
    archivedTasks: (store.archivedTasks || []).map(({ id, title }) => ({ id, title })),
  };
}
