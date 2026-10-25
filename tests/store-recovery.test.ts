import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../lib/seed';
import { plan } from '../lib/domain';
import type { Run } from '../lib/types';

test('real workspace startup recovery preserves sent billing and maps active steps once; empty edits do not write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-startup-recovery-'));
  process.env.CG_DATA_DIR = dir;
  try {
    const data = seed(),
      task = data.tasks[0];
    const opts = {
      strategy: 'S0' as const,
      mode: 'live' as const,
      selfCheck: true,
      contextMode: 'continue' as const,
      slot: 'a' as const,
      budget: null,
    };
    const run = {
      ...opts,
      id: 'recovery-test',
      state: 'running',
      baseRevision: task.currentRevision,
      steps: plan(opts),
      createdAt: '',
      summary: '',
      limit: 2,
      findings: [],
      branch: '',
      deadline: 0,
    } as Run;
    run.steps[0].status = 'running';
    run.steps[0].sent = true;
    run.steps[0].cost = 0.1;
    task.runs.push(run);
    const file = path.join(dir, 'workspace.json');
    fs.writeFileSync(file, JSON.stringify(data));
    const { readStore, editTask } = await import('../lib/store');
    const recovered = readStore().tasks[0].runs[0];
    assert.equal(recovered.state, 'interrupted');
    assert.ok(recovered.steps.every((s) => s.status === 'cancelled'));
    assert.equal(recovered.steps[0].cost, 0.1);
    assert.equal(recovered.steps[0].sent, true);
    assert.match(recovered.error!, /重启/);
    assert.ok(recovered.endedAt);
    const before = fs.readFileSync(file, 'utf8');
    const stamp = fs.statSync(file, { bigint: true }).mtimeNs;
    editTask(task.id, (t) => t.title);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, stamp);
    assert.equal(readStore().tasks[0].runs[0].state, 'interrupted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
