import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from './model.ts';
import { runWorkflow } from './engine.ts';
import {
  MAX_RUN_STEPS, RUN_MAX_AGE_MS, formatDuration, parseRecord, parseRunQuery, recordFromOutcome, runDuration, runFromRow,
} from './runs.ts';

const WF = '12345678-1234-4234-8234-123456789abc';
const ITEM = '87654321-4321-4321-8321-cba987654321';
const NOW = Date.parse('2026-10-22T12:00:00Z');
const step = (patch = {}) => ({
  nodeId: 't', kind: 'trigger', label: 'Start', status: 'succeeded', port: 'next', startedAt: NOW - 2000, finishedAt: NOW - 1500, ...patch,
});
const record = (patch = {}) => ({
  workflowId: WF, status: 'completed', errorCode: null, startedAt: NOW - 2000, finishedAt: NOW - 1000, steps: [step()], ...patch,
});

test('parseRecord accepts a finished run and stores ISO step times', () => {
  const input = parseRecord(record({ sourceItemId: ITEM }), NOW);
  assert.equal(input.status, 'completed');
  assert.equal(input.sourceItemId, ITEM);
  assert.equal(input.steps[0].startedAt, new Date(NOW - 2000).toISOString());
  assert.equal(parseRecord(record(), NOW).sourceItemId, null);
  assert.equal(parseRecord(record({ status: 'canceled', errorCode: 'canceled' }), NOW).errorCode, 'canceled');
});

test('parseRecord rejects bad ids, statuses, times and steps', () => {
  const bad = [
    null, 'x', record({ workflowId: 'nope' }), record({ status: 'running' }), record({ status: 'bogus' }),
    record({ errorCode: 'Has Spaces' }), record({ finishedAt: NOW - 3000 }), record({ startedAt: 'yesterday' }),
    record({ startedAt: NOW - RUN_MAX_AGE_MS - 1 }), record({ finishedAt: NOW + 10 * 60 * 1000 }),
    record({ sourceItemId: 'item-1' }), record({ steps: 'none' }),
    record({ steps: Array.from({ length: MAX_RUN_STEPS + 1 }, () => step()) }),
    record({ steps: [step({ kind: 'robot' })] }), record({ steps: [step({ nodeId: 'a b' })] }),
    record({ steps: [step({ label: 'x'.repeat(81) })] }), record({ steps: [step({ port: 'Next!' })] }),
    record({ steps: [step({ status: 'done' })] }), record({ steps: [step({ finishedAt: NOW - 5000 })] }),
  ];
  for (const value of bad) assert.equal(parseRecord(value, NOW), null, JSON.stringify(value)?.slice(0, 120));
  assert.ok(parseRecord(record({ steps: [step({ status: 'running', finishedAt: null, port: null })] }), NOW));
});

test('parseRunQuery needs a workspace and validates filters', () => {
  const q = (text) => parseRunQuery(new URLSearchParams(text));
  assert.equal(q(''), null);
  assert.equal(q(`workspaceId=${WF}&status=bogus`), null);
  assert.equal(q(`workspaceId=${WF}&itemId=nope`), null);
  assert.equal(q(`workspaceId=${WF}&before=never`), null);
  assert.deepEqual(q(`workspaceId=${WF}`), { workspaceId: WF, workflowId: null, itemId: null, status: null, before: null });
  assert.deepEqual(q(`workspaceId=${WF}&workflowId=${WF}&itemId=${ITEM}&status=failed&before=2026-10-22T00:00:00Z`), {
    workspaceId: WF, workflowId: WF, itemId: ITEM, status: 'failed', before: '2026-10-22T00:00:00.000Z',
  });
});

test('runFromRow maps items, and steps only when selected; bad stored steps are dropped', () => {
  const row = {
    id: 'r', workspace_id: 'w', workflow_id: null, workflow_name: 'Digest', workflow_revision: 2, mode: 'test',
    trigger: 'manual', status: 'failed', error_code: 'step_failed', started_at: 'a', finished_at: 'b',
    workflow_run_items: [{ item_id: ITEM, role: 'source' }],
  };
  const run = runFromRow(row);
  assert.deepEqual(run.items, [{ itemId: ITEM, role: 'source' }]);
  assert.equal(run.workflowId, null);
  assert.equal('steps' in run, false);
  const detail = runFromRow({ ...row, steps: [{ ...step(), startedAt: 'x', finishedAt: 'y' }, { nodeId: 1 }, 'junk'] });
  assert.equal(detail.steps.length, 1);
  assert.equal(runFromRow({ ...row, workflow_run_items: null }).items.length, 0);
});

test('recordFromOutcome turns an engine run into a body parseRecord accepts', async () => {
  const t = { ...createNode('trigger', 0, 0), id: 't', label: 'Start' };
  const a = { ...createNode('agent', 0, 0), id: 'a', label: 'Draft', config: { prompt: 'Sum {{previous}}' } };
  const e = { ...createNode('end', 0, 0), id: 'e', label: 'Done' };
  const definition = { version: 1, nodes: [t, a, e], edges: [{ id: 'e1', from: 't', to: 'a', port: 'next' }, { id: 'e2', from: 'a', to: 'e', port: 'next' }] };
  let clock = NOW - 5000;
  const now = () => (clock += 10);
  const done = await runWorkflow(definition, { agent: async () => ({ output: 'secret draft text' }), approval: async () => ({ output: '' }) }, { now });
  const body = recordFromOutcome(WF, definition, done, { startedAt: NOW - 5000, finishedAt: now(), sourceItemId: ITEM });
  assert.equal(body.status, 'completed');
  assert.deepEqual(body.steps.map((s) => s.label), ['Start', 'Draft', 'Done']);
  assert.ok(!JSON.stringify(body).includes('secret draft text'), 'no step output is recorded');
  assert.ok(parseRecord(JSON.parse(JSON.stringify(body)), NOW));

  let stop = false;
  const canceled = await runWorkflow(definition, {
    agent: async () => { stop = true; return { output: '' }; }, approval: async () => ({ output: '' }),
  }, { now, canceled: () => stop });
  assert.equal(recordFromOutcome(WF, definition, canceled, { startedAt: NOW - 5000, finishedAt: now() }).status, 'canceled');
  const failed = await runWorkflow(definition, { agent: async () => { throw new Error('x'); }, approval: async () => ({ output: '' }) }, { now });
  const failedBody = recordFromOutcome(WF, definition, failed, { startedAt: NOW - 5000, finishedAt: now() });
  assert.deepEqual([failedBody.status, failedBody.errorCode, failedBody.sourceItemId], ['failed', 'step_failed', null]);
  assert.equal(recordFromOutcome(WF, definition, { status: 'invalid', steps: [], error: 'invalid_definition' }, { startedAt: 1, finishedAt: 2 }).status, 'invalid');
});

test('durations read as short, fixed formats', () => {
  assert.equal(runDuration({ startedAt: '2026-10-22T12:00:00Z', finishedAt: '2026-10-22T12:00:04.200Z' }), 4200);
  assert.equal(runDuration({ startedAt: '2026-10-22T12:00:00Z', finishedAt: null }, Date.parse('2026-10-22T12:01:00Z')), 60000);
  assert.equal(runDuration({ startedAt: 'nope', finishedAt: null }), null);
  assert.equal(formatDuration(null), '–');
  assert.equal(formatDuration(420), '0.4s');
  assert.equal(formatDuration(12_400), '12s');
  assert.equal(formatDuration(185_000), '3m 05s');
  assert.equal(formatDuration(7_800_000), '2h 10m');
});
