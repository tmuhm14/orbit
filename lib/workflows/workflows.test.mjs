import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect, createNode, fillTemplate, parseDefinition, removeNode, runnable, starterDefinition, validateWorkflow,
} from './model.ts';
import { evaluateCondition, runWorkflow } from './engine.ts';

const node = (kind, id, config = {}) => ({ ...createNode(kind, 0, 0), id, label: id, config: { ...createNode(kind, 0, 0).config, ...config } });
const edge = (from, to, port = 'next') => ({ id: `${from}-${port}-${to}`, from, to, port });
const def = (nodes, edges) => ({ version: 1, nodes, edges });
const messages = (d) => validateWorkflow(d).map((i) => `${i.severity}: ${i.message}`);

// trigger → draft → check (contains "ok") → yes: review → approved: save → end
//                                          → no: end
function branching() {
  return def(
    [
      node('trigger', 't'),
      node('agent', 'draft', { prompt: 'Summarize {{previous}}' }),
      node('condition', 'check', { operator: 'contains', value: 'ok' }),
      node('approval', 'review'),
      node('action', 'save', { title: 'Summary: {{previous}}', bucket: 'reference' }),
      node('end', 'done'),
    ],
    [
      edge('t', 'draft'), edge('draft', 'check'), edge('check', 'review', 'yes'), edge('check', 'done', 'no'),
      edge('review', 'save', 'approved'), edge('review', 'done', 'rejected'), edge('save', 'done'),
    ],
  );
}

test('the starter definition parses and is runnable once its prompt is written', () => {
  const starter = starterDefinition();
  assert.deepEqual(parseDefinition(JSON.parse(JSON.stringify(starter))), starter);
  assert.deepEqual(messages(starter), ['error: “Draft a summary” needs a prompt']);
  starter.nodes[1].config.prompt = 'Summarize the item';
  assert.ok(runnable(validateWorkflow(starter)));
});

test('parseDefinition rejects malformed shapes and limits', () => {
  const good = branching();
  assert.ok(parseDefinition(good));
  assert.equal(parseDefinition(null), null);
  assert.equal(parseDefinition({ ...good, version: 2 }), null);
  assert.equal(parseDefinition({ ...good, nodes: [...good.nodes, good.nodes[0]] }), null, 'duplicate node id');
  assert.equal(parseDefinition({ ...good, nodes: [{ ...good.nodes[0], kind: 'shell' }] }), null);
  assert.equal(parseDefinition({ ...good, edges: [edge('t', 'missing')] }), null);
  assert.equal(parseDefinition(def([node('delay', 'd', { minutes: 0 })], [])), null);
  assert.equal(parseDefinition(def([{ ...node('agent', 'a'), id: 'bad id' }], [])), null);
  assert.equal(parseDefinition(def([node('agent', 'a', { prompt: 'x'.repeat(4001) })], [])), null);
  assert.equal(parseDefinition(def(Array.from({ length: 61 }, (_, i) => node('end', `e${i}`)), [])), null);
  const far = parseDefinition(def([{ ...node('end', 'e'), x: 1e9, y: -1e9 }], []));
  assert.deepEqual([far.nodes[0].x, far.nodes[0].y], [20000, -20000]);
});

test('validateWorkflow reports structural errors and soft warnings', () => {
  assert.deepEqual(messages(branching()), []);
  assert.deepEqual(messages(def([], [])), ['error: Add a trigger to start the workflow']);
  const loop = def(
    [node('trigger', 't'), node('agent', 'a', { prompt: 'p' }), node('agent', 'b', { prompt: 'p' })],
    [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
  );
  assert.ok(messages(loop).includes('error: Steps loop back on themselves; remove a connection'));
  const wrongPort = def([node('trigger', 't'), node('end', 'e')], [edge('t', 'e', 'yes')]);
  assert.ok(messages(wrongPort).includes('error: “t” has no “yes” output'));
  const intoTrigger = def([node('trigger', 't'), node('end', 'e'), node('trigger', 't2')], [edge('t', 'e'), edge('t2', 't')]);
  assert.ok(messages(intoTrigger).includes('error: Nothing can lead into the trigger'));
  assert.ok(messages(intoTrigger).includes('error: A workflow has one trigger'));
  const loose = def([node('trigger', 't'), node('condition', 'c', { operator: 'is_empty' }), node('end', 'stray')], [edge('t', 'c'), edge('c', 'stray', 'yes')]);
  assert.deepEqual(messages(loose), ['warning: “c” has nothing on its “no” branch; the run ends there']);
  const orphan = def([node('trigger', 't'), node('end', 'e')], []);
  assert.deepEqual(messages(orphan), ['warning: “t” isn\'t connected to a next step', 'warning: “e” can\'t be reached from the trigger']);
});

test('connect replaces an output and removeNode drops its edges', () => {
  let d = branching();
  d = connect(d, 'check', 'yes', 'save');
  assert.deepEqual(d.edges.filter((e) => e.from === 'check').map((e) => [e.port, e.to]).sort(), [['no', 'done'], ['yes', 'save']]);
  assert.equal(connect(d, 'save', 'next', 'save'), d, 'no self-loops');
  d = removeNode(d, 'review');
  assert.ok(!d.edges.some((e) => e.from === 'review' || e.to === 'review'));
  assert.equal(fillTemplate('A {{ previous }} B {{previous}}', 'x'), 'A x B x');
});

test('conditions compare case-insensitively', () => {
  assert.equal(evaluateCondition({ operator: 'contains', value: 'OK' }, 'all ok'), 'yes');
  assert.equal(evaluateCondition({ operator: 'not_contains', value: 'ok' }, 'all ok'), 'no');
  assert.equal(evaluateCondition({ operator: 'is_empty', value: '' }, '  '), 'yes');
  assert.equal(evaluateCondition({ operator: 'not_empty', value: '' }, ''), 'no');
});

test('runWorkflow follows the branches each step chooses', async () => {
  const prompts = [];
  const handlers = {
    agent: async (n, { previous }) => { prompts.push(fillTemplate(n.config.prompt, previous)); return { output: 'looks ok' }; },
    approval: async () => ({ output: 'approved', port: 'approved' }),
  };
  const updates = [];
  const run = await runWorkflow(branching(), handlers, { input: 'the item', onStep: (s) => updates.push(s) });
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.steps.map((s) => [s.nodeId, s.port]), [
    ['t', 'next'], ['draft', 'next'], ['check', 'yes'], ['review', 'approved'], ['save', 'next'], ['done', null],
  ]);
  assert.deepEqual(prompts, ['Summarize the item']);
  assert.equal(run.steps[4].output, 'Summary: approved');
  assert.equal(updates.at(-1).every((s) => s.status === 'succeeded'), true);

  const rejected = await runWorkflow(branching(), { ...handlers, approval: async () => ({ output: 'no', port: 'rejected' }) });
  assert.deepEqual(rejected.steps.map((s) => s.nodeId), ['t', 'draft', 'check', 'review', 'done']);
  const other = await runWorkflow(branching(), { ...handlers, agent: async () => ({ output: 'nope' }) });
  assert.deepEqual(other.steps.map((s) => s.nodeId), ['t', 'draft', 'check', 'done']);
});

test('runWorkflow refuses invalid definitions and reports failures without content', async () => {
  const handlers = { agent: async () => { throw new Error('secret prompt text'); }, approval: async () => ({ output: '' }) };
  assert.deepEqual(await runWorkflow(def([], []), handlers), { status: 'invalid', steps: [], error: 'invalid_definition' });
  const failed = await runWorkflow(branching(), handlers);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'step_failed');
  assert.deepEqual(failed.steps.map((s) => [s.nodeId, s.status]), [['t', 'succeeded'], ['draft', 'failed']]);
  const stopped = await runWorkflow(branching(), handlers, { canceled: () => true });
  assert.equal(stopped.error, 'canceled');
});
