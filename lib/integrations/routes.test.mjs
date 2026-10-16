import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { loadTs } from '../../tests/load-ts.mjs';
import { captureInput, uuid } from './validation.ts';

// /api/v1 with the real auth, grants and audit modules over in-memory
// Supabase doubles. Synthetic keys, tokens and pepper only.
const PEPPER = 'synthetic-pepper-synthetic-pepper-0123';
const USER = '11111111-1111-4111-8111-111111111111';
const W1 = '12345678-1234-4234-8234-123456789abc';
const W2 = '22345678-1234-4234-8234-123456789abc';
const NOTE = '99999999-1234-4234-8234-123456789abc';
const USER_TOKEN = 'synthetic.user.jwt-token';

const grantsMod = loadTs(new URL('../grants/server.ts', import.meta.url));
const configMod = loadTs(new URL('../grants/config.ts', import.meta.url));
const keysMod = loadTs(new URL('../grants/keys.ts', import.meta.url), { 'node:crypto': crypto });
const auditMod = loadTs(new URL('../grants/audit.ts', import.meta.url));

// State the doubles read on every request (no caching in the code under test).
let state;
let logs;
const original = { warn: console.warn, error: console.error, info: console.info, log: console.log };
beforeEach(() => {
  process.env.ORBIT_API_KEY_PEPPER = PEPPER;
  process.env.ORBIT_USER_TOKEN_SUNSET = '2099-01-01'; // the default (2026-11-19) is checked in lib/grants/keys.test.mjs
  state = { clients: [], audit: [], rpc: [], calls: [], inserts: [], workspaces: [], userTokenValid: true, failStorage: false, adminConfigured: true };
  logs = [];
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push(args.map(String).join(' '));
});
afterEach(() => Object.assign(console, original));

function issue(grants, { revoked = false } = {}) {
  const k = keysMod.generateApiKey(PEPPER);
  state.clients.push({ id: `cccccccc-0000-4000-8000-${String(state.clients.length + 1).padStart(12, '0')}`, prefix: k.prefix,
    hash: k.hash, revoked, grants });
  return { ...k, client: state.clients.at(-1) };
}
const grant = (workspaceId, capability, agentEnabled = true) => ({ workspaceId, capability, agentEnabled,
  constraints: capability === 'item.write' ? { operations: ['create'] } : {} });

function query(table) {
  const calls = [];
  state.calls.push([table, calls]);
  const result = () => {
    if (state.failStorage) return { data: null, error: { message: 'boom' } };
    if (table === 'workspaces') {
      const ids = calls.find((c) => c[0] === 'in')?.[2];
      const id = calls.find((c) => c[0] === 'eq' && c[1] === 'id')?.[2];
      const rows = state.workspaces.filter((w) => w.agent_enabled && (!ids || ids.includes(w.id)) && (!id || w.id === id))
        .map(({ id, name, color }) => ({ id, name, color }));
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
  const q = {
    select: (...a) => (calls.push(['select', ...a]), q),
    eq: (...a) => (calls.push(['eq', ...a]), q),
    in: (...a) => (calls.push(['in', ...a]), q),
    order: (...a) => (calls.push(['order', ...a]), q),
    range: async (...a) => (calls.push(['range', ...a]), result()),
    maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
    insert: async (row) => (state.inserts.push([table, row]), { error: state.failStorage ? {} : null }),
    then: (resolve) => resolve(result()),
  };
  return q;
}
const admin = {
  from: query,
  rpc: async (name, args) => {
    state.rpc.push([name, args]);
    if (name === 'verify_agent_key') {
      const c = state.clients.find((x) => x.prefix === args.p_key_prefix);
      if (!c || c.hash !== args.p_key_hash) return { data: null, error: null };
      if (c.revoked) return { data: { status: 'revoked', userId: USER, clientId: c.id }, error: null };
      return { data: { status: 'ok', userId: USER, clientId: c.id, grants: c.grants }, error: null };
    }
    if (name === 'record_access_event') { state.audit.push(args); return { error: null }; }
    return { data: null, error: { message: 'unknown' } };
  },
};
const userClient = {
  from: query,
  auth: { getUser: async () => state.userTokenValid ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: {} } },
};
const authMod = loadTs(new URL('./auth.ts', import.meta.url), {
  '@supabase/supabase-js': { createClient: () => userClient },
  '@/lib/supabase/config': { authConfig: () => ({ url: 'http://supabase.test', key: 'publishable' }) },
  '@/lib/supabase/admin': { createAdminClient: () => (state.adminConfigured ? admin : null) },
  '@/lib/grants/config': configMod,
  '@/lib/grants/keys': keysMod,
  '@/lib/grants/server': grantsMod,
  '@/lib/grants/audit': auditMod,
});
const routeImports = {
  '@/lib/integrations/auth': authMod,
  '@/lib/integrations/validation': { captureInput, uuid },
  '@/lib/grants/server': grantsMod,
  '@/lib/notes': { createNote: (title, bucket, workspaceId) => ({ id: NOTE, title, bucket, workspaceId, kind: 'note', projectId: null,
    waitingOn: null, waitingFor: null, nextCheckOn: null }),
    textDoc: (text) => ({ text }), isItemKind: (k) => ['note', 'task', 'project', 'document', 'followup'].includes(k) },
  '@/lib/notes-db': { toRow: (note, userId) => ({ ...note, user_id: userId, kind: note.kind, project_id: note.projectId,
    waiting_on: note.waitingOn, waiting_for: note.waitingFor, next_check_on: note.nextCheckOn }) },
};
const notes = loadTs(new URL('../../app/api/v1/notes/route.ts', import.meta.url), routeImports);
const workspaces = loadTs(new URL('../../app/api/v1/workspaces/route.ts', import.meta.url), routeImports);

const req = (credential, { workspaceId = W1, body, query = '' } = {}) => new Request(
  `http://localhost/api/v1/notes?workspaceId=${workspaceId}${query}`, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
    ...(body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
const capture = (workspaceId = W1) => ({ workspaceId, title: 'Synthetic title', text: 'Synthetic body' });
const call = async (handler, request) => {
  const response = await handler(request);
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const enable = (...ids) => { state.workspaces = ids.map((id, i) => ({ id, name: `W${i}`, color: null, agent_enabled: true })); };

test('every route refuses a missing credential before storage', async () => {
  for (const handler of [notes.GET, notes.POST, workspaces.GET]) {
    const r = await call(handler, req(null, { body: handler === notes.POST ? capture() : undefined }));
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'invalid_credentials');
  }
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.rpc, []);
});

test('an API key lists only granted workspaces, reads with workspace.read and captures with item.write', async () => {
  enable(W1, W2);
  const k = issue([grant(W1, 'workspace.read'), grant(W1, 'item.write')]);
  const list = await call(workspaces.GET, req(k.key));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.workspaces, [{ id: W1, name: 'W0', color: null, capabilities: ['item.write', 'workspace.read'] }]);
  assert.equal(list.headers.get('deprecation'), null, 'no deprecation notice for API keys');
  const wsQuery = state.calls.find(([t]) => t === 'workspaces')[1];
  assert.ok(wsQuery.some((c) => c[0] === 'eq' && c[1] === 'user_id' && c[2] === USER));
  assert.ok(wsQuery.some((c) => c[0] === 'in' && c[1] === 'id' && c[2].length === 1 && c[2][0] === W1));
  assert.equal((await call(notes.GET, req(k.key))).status, 200);
  const notesQuery = state.calls.find(([t]) => t === 'notes')[1];
  assert.ok(notesQuery.some((c) => c[0] === 'eq' && c[1] === 'user_id' && c[2] === USER), 'reads are filtered to the key owner');
  const created = await call(notes.POST, req(k.key, { body: capture() }));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: NOTE, workspaceId: W1, bucket: 'inbox', revision: 1 });
  const [table, row] = state.inserts[0];
  assert.equal(table, 'notes');
  assert.equal(row.user_id, USER);
  for (const key of ['kind', 'project_id', 'waiting_on', 'waiting_for', 'next_check_on']) assert.equal(Object.hasOwn(row, key), false);
  // The verifier gets the prefix and an HMAC, never the key or its secret.
  const verify = state.rpc.find(([n]) => n === 'verify_agent_key')[1];
  assert.deepEqual(Object.keys(verify).sort(), ['p_key_hash', 'p_key_prefix']);
  assert.equal(verify.p_key_hash, crypto.createHmac('sha256', PEPPER).update(k.key).digest('hex'));
  assert.equal(JSON.stringify(state.rpc).includes(k.key.slice(22)), false);
  // One content-free audit row per operation.
  assert.deepEqual(state.audit.map((a) => [a.p_principal_type, a.p_principal_id, a.p_operation, a.p_workspace_id, a.p_resource_id, a.p_outcome, a.p_code]), [
    ['agent_client', k.client.id, 'workspace.list', null, null, 'allowed', null],
    ['agent_client', k.client.id, 'item.read', W1, null, 'allowed', null],
    ['agent_client', k.client.id, 'item.create', W1, NOTE, 'allowed', null],
  ]);
  assert.equal(JSON.stringify(state.audit).includes('Synthetic'), false, 'no titles or text in the audit');
});

test('grants are enforced per operation and per workspace, with the kill switch on top', async () => {
  enable(W1, W2);
  const readOnly = issue([grant(W1, 'workspace.read')]);
  const denied = await call(notes.POST, req(readOnly.key, { body: capture() }));
  assert.deepEqual([denied.status, denied.body.code, denied.body.capability], [403, 'capability_denied', 'item.write']);
  const other = await call(notes.GET, req(readOnly.key, { workspaceId: W2 }));
  assert.deepEqual([other.status, other.body.code], [403, 'capability_denied']);
  const captureOnly = issue([grant(W2, 'item.write')]);
  assert.equal((await call(notes.GET, req(captureOnly.key, { workspaceId: W2 }))).status, 403, 'item.write does not allow reading');
  assert.equal((await call(notes.POST, req(captureOnly.key, { body: capture(W2) }))).status, 201);
  const disabled = issue([grant(W1, 'workspace.read', false), grant(W2, 'workspace.read')]);
  const off = await call(notes.GET, req(disabled.key));
  assert.deepEqual([off.status, off.body.code], [403, 'agent_disabled']);
  assert.deepEqual((await call(workspaces.GET, req(disabled.key))).body.workspaces.map((w) => w.id), [W2]);
  const none = issue([]);
  assert.deepEqual((await call(workspaces.GET, req(none.key))).body, { workspaces: [] });
  assert.equal(state.inserts.length, 1, 'only the granted capture wrote');
  assert.deepEqual(state.audit.filter((a) => a.p_outcome === 'denied').map((a) => [a.p_operation, a.p_code]), [
    ['item.create', 'capability_denied'], ['item.read', 'capability_denied'], ['item.read', 'capability_denied'],
    ['item.read', 'agent_disabled']]);
});

test('revocation and grant changes apply to the next request; wrong, unknown and malformed keys are refused', async () => {
  enable(W1);
  const k = issue([grant(W1, 'workspace.read')]);
  assert.equal((await call(notes.GET, req(k.key))).status, 200);
  k.client.grants = [];
  assert.equal((await call(notes.GET, req(k.key))).status, 403, 'a removed grant applies immediately');
  k.client.revoked = true;
  const revoked = await call(notes.GET, req(k.key));
  assert.deepEqual([revoked.status, revoked.body.code], [401, 'client_revoked']);
  assert.deepEqual(state.audit.at(-1), { p_user_id: USER, p_principal_type: 'agent_client', p_principal_id: k.client.id,
    p_operation: 'item.read', p_workspace_id: null, p_resource_id: null, p_outcome: 'denied', p_code: 'client_revoked' });
  const wrongSecret = `orbit_sk_${k.prefix}_${'A'.repeat(43)}`;
  const wrongPrefix = `orbit_sk_ffffffffffff_${k.key.slice(22)}`;
  for (const key of [wrongSecret, wrongPrefix, 'orbit_sk_short', `orbit_sk_${k.prefix}_${'A'.repeat(42)}!`]) {
    const r = await call(notes.GET, req(key));
    assert.deepEqual([r.status, r.body.code], [401, 'invalid_credentials'], key.slice(0, 20));
    assert.equal(JSON.stringify(r.body).includes(key), false);
  }
  assert.equal(state.inserts.length, 0);
});

test('keys fail fast without the pepper or the server role, without echoing the key', async () => {
  enable(W1);
  const k = issue([grant(W1, 'workspace.read')]);
  delete process.env.ORBIT_API_KEY_PEPPER;
  const r = await call(notes.GET, req(k.key));
  assert.deepEqual([r.status, r.body.code], [503, 'not_configured']);
  assert.ok(logs.some((l) => l.includes('ORBIT_API_KEY_PEPPER is not set')));
  process.env.ORBIT_API_KEY_PEPPER = 'too-short';
  assert.equal((await call(notes.GET, req(k.key))).status, 503);
  process.env.ORBIT_API_KEY_PEPPER = PEPPER;
  state.adminConfigured = false;
  assert.equal((await call(notes.GET, req(k.key))).status, 503);
  assert.equal(state.rpc.length, 0);
});

test('Supabase user tokens still work in the window, with Deprecation/Sunset headers and a user_token audit', async () => {
  enable(W1);
  const list = await call(workspaces.GET, req(USER_TOKEN));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.workspaces, [{ id: W1, name: 'W0', color: null, capabilities: ['item.write', 'workspace.read'] }]);
  assert.equal(list.headers.get('deprecation'), `@${Date.parse('2026-10-20T00:00:00Z') / 1000}`);
  assert.equal(list.headers.get('sunset'), 'Thu, 01 Jan 2099 00:00:00 GMT');
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  assert.equal((await call(notes.GET, req(USER_TOKEN))).status, 200);
  const created = await call(notes.POST, req(USER_TOKEN, { body: capture() }));
  assert.equal(created.status, 201);
  assert.ok(created.headers.get('sunset'));
  assert.equal(state.inserts[0][1].user_id, USER);
  // The legacy policy is still today's agent_enabled switch.
  const off = await call(notes.GET, req(USER_TOKEN, { workspaceId: W2 }));
  assert.deepEqual([off.status, off.body.code], [403, 'agent_disabled']);
  assert.ok(off.headers.get('deprecation'), 'denials carry the notice too');
  assert.deepEqual(state.audit.map((a) => [a.p_principal_type, a.p_principal_id, a.p_operation, a.p_outcome]), [
    ['user_token', null, 'workspace.list', 'allowed'], ['user_token', null, 'item.read', 'allowed'],
    ['user_token', null, 'item.create', 'allowed'], ['user_token', null, 'item.read', 'denied']]);
  // Without the server role the request still works; the audit gap is logged.
  state.adminConfigured = false;
  assert.equal((await call(notes.GET, req(USER_TOKEN))).status, 200);
  assert.ok(logs.includes('access audit unavailable: server role not configured'));
  state.userTokenValid = false;
  assert.equal((await call(notes.GET, req(USER_TOKEN))).body.code, 'invalid_credentials');
});

test('after the sunset date user tokens are refused with credential_type_unsupported', async () => {
  enable(W1);
  process.env.ORBIT_USER_TOKEN_SUNSET = '2020-01-01';
  const r = await call(notes.GET, req(USER_TOKEN));
  assert.deepEqual([r.status, r.body.code], [401, 'credential_type_unsupported']);
  process.env.ORBIT_USER_TOKEN_SUNSET = 'soon';
  assert.equal((await call(notes.GET, req(USER_TOKEN))).status, 503);
  // Keys are unaffected by the sunset.
  process.env.ORBIT_USER_TOKEN_SUNSET = '2020-01-01';
  const k = issue([grant(W1, 'workspace.read')]);
  assert.equal((await call(notes.GET, req(k.key))).status, 200);
});

test('malformed input and storage failures return safe errors', async () => {
  enable(W1);
  const k = issue([grant(W1, 'workspace.read'), grant(W1, 'item.write')]);
  assert.equal((await call(notes.GET, req(k.key, { workspaceId: 'bad' }))).status, 400);
  assert.equal((await call(notes.GET, req(k.key, { query: '&kind=epic' }))).status, 400);
  for (const body of ['{', { ...capture(), user_id: 'other' }, { ...capture(), kind: 'task' }])
    assert.equal((await call(notes.POST, req(k.key, { body }))).status, 400);
  const big = await notes.POST(req(k.key, { body: 'a'.repeat(250001) }));
  assert.equal(big.status, 413);
  state.failStorage = true;
  assert.equal((await call(notes.GET, req(k.key))).status, 500);
  assert.equal((await call(workspaces.GET, req(k.key))).status, 500);
  assert.equal((await call(notes.POST, req(k.key, { body: capture() }))).status, 500);
  state.failStorage = false;
  assert.equal((await call(notes.GET, req(k.key, { query: '&kind=project' }))).status, 200);
  const select = state.calls.filter(([t]) => t === 'notes').at(-1)[1];
  assert.match(select.find((c) => c[0] === 'select')[1], /,revision,kind,project_id,waiting_on,waiting_for,next_check_on$/);
  assert.ok(select.some((c) => c[0] === 'eq' && c[1] === 'kind' && c[2] === 'project'));
});

test('no key, secret or token appears in any log line, response or error', async () => {
  enable(W1);
  const k = issue([grant(W1, 'workspace.read')]);
  const bad = `orbit_sk_${k.prefix}_${'Z'.repeat(43)}`;
  const responses = [];
  for (const credential of [k.key, bad, 'orbit_sk_garbage-secret', USER_TOKEN]) {
    for (const handler of [notes.GET, workspaces.GET]) responses.push(await call(handler, req(credential)));
    responses.push(await call(notes.POST, req(credential, { body: capture() })));
  }
  k.client.revoked = true;
  responses.push(await call(notes.GET, req(k.key)));
  delete process.env.ORBIT_API_KEY_PEPPER;
  responses.push(await call(notes.GET, req(k.key)));
  const everything = JSON.stringify([logs, responses.map((r) => [r.body, [...r.headers]]), state.audit]);
  for (const secret of [k.key, k.key.slice(22), bad.slice(22), 'garbage-secret', USER_TOKEN, PEPPER, k.hash])
    assert.equal(everything.includes(secret), false, `leaked ${secret.slice(0, 12)}`);
  assert.ok(logs.some((l) => l.includes(`orbit_sk_${k.prefix}`)), 'refusals log the prefix');
});
