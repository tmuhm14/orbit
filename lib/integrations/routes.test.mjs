import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { stripTypeScriptTypes } from 'node:module';
import { captureInput, uuid } from './validation.ts';

// Compile route modules with injected storage/auth. No live credentials or services.
const require = createRequire(import.meta.url);
const id = '12345678-1234-1234-1234-123456789abc';
const reply = (body, status = 200) => Response.json(body, { status });
function load(path, auth) {
  const exports = {};
  const compiled = stripTypeScriptTypes(readFileSync(path, 'utf8'))
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1} = require("$2");')
    .replace(/export async function (\w+)/g, 'exports.$1 = async function $1');
  const imports = {
    '@/lib/integrations/auth': { integrationUser: async () => auth, reply },
    '@/lib/integrations/validation': { captureInput, uuid },
    '@/lib/notes': { createNote: (title, bucket, workspaceId) => ({ id, title, bucket, workspaceId }), textDoc: text => ({ text }) },
    '@/lib/notes-db': { toRow: (note, userId) => ({ ...note, user_id: userId }) },
  };
  new Function('require', 'exports', compiled)(name => imports[name] ?? require(name), exports);
  return exports;
}
function storage({ enabled = true, fail = false } = {}) {
  const calls = [];
  const query = {
    select: (...a) => { calls.push(['select', ...a]); return query; },
    eq: (...a) => { calls.push(['eq', ...a]); return query; },
    order: () => query,
    maybeSingle: async () => ({ data: enabled ? { id } : null, error: fail ? {} : null }),
    range: async () => ({ data: [], error: fail ? {} : null }),
    insert: async row => { calls.push(['insert', row]); return { error: fail ? {} : null }; },
    then: resolve => resolve({ data: [], error: fail ? {} : null }),
  };
  return { calls, user: { id: 'synthetic-user' }, supabase: { from: () => query } };
}
const request = (body) => new Request(`http://localhost/api/v1/notes?workspaceId=${id}`, {
  ...(body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
test('all routes reject unauthenticated requests before storage', async () => {
  for (const path of ['app/api/v1/notes/route.ts', 'app/api/v1/workspaces/route.ts']) {
    const routes = load(path, { error: reply({ error: 'Unauthorized' }, 401) });
    for (const handler of Object.values(routes)) assert.equal((await handler(request())).status, 401);
  }
});
test('note listing and capture enforce user and workspace permissions', async () => {
  const auth = storage();
  const routes = load('app/api/v1/notes/route.ts', auth);
  assert.equal((await routes.GET(request())).status, 200);
  assert.equal((await routes.POST(request({ workspaceId: id, title: 'Synthetic', text: 'Test' }))).status, 201);
  assert.ok(auth.calls.some(c => c[0] === 'eq' && c[1] === 'user_id' && c[2] === auth.user.id));
  assert.ok(auth.calls.some(c => c[0] === 'eq' && c[1] === 'agent_enabled' && c[2] === true));
  assert.equal(auth.calls.find(c => c[0] === 'insert')[1].user_id, auth.user.id);
  const denied = load('app/api/v1/notes/route.ts', storage({ enabled: false }));
  assert.equal((await denied.GET(request())).status, 403);
  assert.equal((await denied.POST(request({ workspaceId: id, title: 'Test', text: '' }))).status, 403);
});
test('routes reject malformed input and return safe storage errors', async () => {
  const routes = load('app/api/v1/notes/route.ts', storage());
  assert.equal((await routes.GET(new Request('http://localhost/api/v1/notes?workspaceId=bad'))).status, 400);
  for (const body of ['{', { workspaceId: id, title: 'Test', text: '', user_id: 'other' }])
    assert.equal((await routes.POST(request(body))).status, 400);
  assert.equal((await routes.POST(request('a'.repeat(250001)))).status, 413);
  const failed = load('app/api/v1/notes/route.ts', storage({ fail: true }));
  assert.equal((await failed.GET(request())).status, 500);
  const workspaces = load('app/api/v1/workspaces/route.ts', storage());
  assert.equal((await workspaces.GET(request())).status, 200);
  assert.equal((await load('app/api/v1/workspaces/route.ts', storage({ fail: true })).GET(request())).status, 500);
});
