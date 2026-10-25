import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../lib/seed';
import { workspaceSummary } from '../lib/workspace-summary';
import { documentInputBudget } from '../lib/document-input';

test('summary excludes large materials/history/messages/audit data while detail and input budget remain complete', () => {
  const store = seed();
  const task = store.tasks[0];
  const secretText = 'ONLY_IN_FULL_DETAIL_'.repeat(2600);
  task.sources = Array.from({ length: 20 }, (_, i) => ({
    id: 'source-' + i,
    name: 'source',
    version: 2,
    text: secretText,
    createdAt: '',
    kind: 'original',
    history: [{ version: 1, text: secretText, createdAt: '' }],
  }));
  task.messages = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    actor: 'user',
    content: secretText,
    createdAt: '',
  }));
  task.goal = secretText;
  task.description = secretText;
  task.findings = Array.from({ length: 60 }, (_, i) => ({
    ...task.findings[0],
    id: 'finding-' + i,
    title: secretText,
    before: secretText,
    after: secretText,
    reason: secretText,
    quote: secretText,
  }));
  task.runs = Array.from({ length: 20 }, (_, i) => ({
    ...task.runs[0],
    id: 'run-' + i,
    state: 'succeeded',
    summary: secretText,
    assessments: [
      {
        criterionId: 'one',
        verdict: 'passed',
        reason: secretText,
        evidence: [{ blockId: 'one', sourceId: 'one', quote: secretText }],
      },
    ],
  }));
  const before = JSON.stringify(store);
  const summary = JSON.stringify(workspaceSummary(store));
  assert.ok(Buffer.byteLength(summary) < 30000);
  assert.ok(!summary.includes('ONLY_IN_FULL_DETAIL'));
  assert.equal(JSON.stringify(store), before);
  assert.equal(workspaceSummary(store).tasks[0].findingCount, 60);
  assert.equal(workspaceSummary(store).tasks[0].runCount, 20);
  assert.equal(
    documentInputBudget(task, {
      strategy: 'S0',
      mode: 'live',
      selfCheck: false,
      contextMode: 'continue',
      slot: 'a',
      budget: null,
    }).exceeded,
    true,
  );
});
