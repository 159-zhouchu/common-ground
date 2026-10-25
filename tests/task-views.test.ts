import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../lib/seed';
import { taskContent } from '../lib/task-views';
import { taskCache } from '../lib/task-cache';
import type { Run } from '../lib/types';

test('large historical bodies and audit blobs never enter main; history preserves bodies without audit', () => {
  const task = seed().tasks[0];
  const old = 'HISTORICAL_BODY_'.repeat(3500),
    audit = 'AUDIT_BODY_'.repeat(5000);
  task.revisions.push(
    ...Array.from({ length: 100 }, (_, i) => ({
      ...task.revisions[0],
      id: 'old-' + i,
      blocks: [{ ...task.revisions[0].blocks[0], content: old }],
    })),
  );
  task.sources[0].history = [{ version: 0, text: old, createdAt: '' }];
  task.messages = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    actor: 'user',
    content: i < 190 ? old : 'recent',
    createdAt: '',
  }));
  task.runs = Array.from(
    { length: 20 },
    (_, i) =>
      ({
        id: 'run-' + i,
        strategy: 'S0',
        selfCheck: false,
        mode: 'live',
        contextMode: 'continue',
        baseRevision: task.currentRevision,
        branch: '',
        state: 'succeeded',
        createdAt: '',
        summary: '',
        limit: 0,
        findings: [],
        slot: 'a',
        deadline: 0,
        budget: null,
        inputManifests: {
          fixture: {
            goal: audit,
            constraint: '',
            sources: [],
            blocks: [],
            messages: [],
            mode: 'continue',
            excluded: [],
            hash: 'fixture',
          },
        },
        steps: [
          {
            id: 'step',
            label: '',
            slot: 'a',
            duty: '',
            status: 'completed',
            cost: 0,
            diagnostic: { excerpt: audit, bytes: audit.length, truncated: false, hash: '' },
            output: { summary: audit, findings: [], questions: [] },
          },
        ],
      }) satisfies Run,
  );
  const before = JSON.stringify(task),
    main = taskContent(task, 'main'),
    history = taskContent(task, 'history');
  const mainJSON = JSON.stringify(main),
    historyJSON = JSON.stringify(history);
  assert.ok(Buffer.byteLength(before) > 10_000_000);
  assert.ok(Buffer.byteLength(mainJSON) < 80_000);
  assert.ok(!mainJSON.includes('HISTORICAL_BODY') && !mainJSON.includes('AUDIT_BODY'));
  assert.ok(historyJSON.includes('HISTORICAL_BODY') && !historyJSON.includes('AUDIT_BODY'));
  assert.deepEqual(main.revisions[0].blocks, task.revisions[0].blocks);
  assert.equal(main.messages.length, 10);
  assert.deepEqual(history.revisions, task.revisions);
  assert.equal(JSON.stringify(task), before);
});

test('task cache keys include version/view, evicts stale versions and caps entry count and bytes', () => {
  const task = seed().tasks[0],
    cache = taskCache(2, 100_000);
  const main = taskContent(task, 'main');
  cache.put(main);
  assert.equal(cache.get(task.id, task.updatedAt, 'main'), main);
  assert.equal(cache.get(task.id, 'wrong-version', 'main'), undefined);
  cache.put(taskContent({ ...task, updatedAt: 'new' }, 'main'));
  assert.equal(cache.get(task.id, task.updatedAt, 'main'), undefined);
  cache.put(taskContent({ ...task, id: 'two' }, 'main'));
  cache.put(taskContent({ ...task, id: 'three' }, 'main'));
  assert.equal(cache.get(task.id, 'new', 'main'), undefined);
  const small = taskCache(4, 1);
  small.put(main);
  assert.equal(small.get(task.id, task.updatedAt, 'main'), undefined);
  cache.clear();
  assert.equal(cache.get('three', task.updatedAt, 'main'), undefined);
});
