import type { Run, Task } from './types';

// The view discriminator distinguishes deliberately unloaded history from empty content.
export type TaskContent = Task & { contentView: 'main' | 'history' };
export function taskContent(task: Task, view: TaskContent['contentView']): TaskContent {
  return {
    ...task,
    contentView: view,
    revisions: task.revisions.map((revision) => ({
      ...revision,
      blocks: view === 'history' || revision.id === task.currentRevision ? revision.blocks : [],
    })),
    sources: task.sources.map(({ history, ...source }) => ({
      ...source,
      ...(view === 'history' && history ? { history } : {}),
    })),
    messages: view === 'history' ? task.messages : task.messages.slice(-10),
    runs: task.runs.map(({ inputManifests: _inputs, ...run }) => ({
      ...run,
      steps: run.steps.map(
        ({ manifest: _manifest, output: _output, diagnostic: _diagnostic, ...step }) => step,
      ),
    })),
  };
}
export type RunAudit = { run: Run };
