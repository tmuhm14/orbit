import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

test('MCP initializes, discovers tools, validates input and safely reports API failures', async () => {
  const client = new Client({ name: 'orbit-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['scripts/orbit-mcp.mjs'], env: { ...process.env, ORBIT_URL: 'http://127.0.0.1:1', ORBIT_ACCESS_TOKEN: 'synthetic-test-token' } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['orbit_list_workspaces', 'orbit_list_notes', 'orbit_capture_note']);
    const invalid = await client.callTool({ name: 'orbit_list_notes', arguments: { workspaceId: 'invalid' } });
    assert.equal(invalid.isError, true);
    const list = tools.find(t => t.name === 'orbit_list_notes');
    assert.deepEqual(list.inputSchema.properties.kind.enum, ['note', 'task', 'project', 'document', 'followup']);
    assert.equal(list.inputSchema.required.includes('kind'), false);
    assert.match(list.description, /waiting_on, waiting_for, next_check_on/, 'follow-up fields are documented');
    assert.equal(Object.hasOwn(list.inputSchema.properties, 'waiting'), false, 'no follow-up filter (ADR 001 asks for none)');
    const capture = tools.find(t => t.name === 'orbit_capture_note');
    assert.equal(Object.hasOwn(capture.inputSchema.properties, 'kind'), false, 'captures stay notes');
    const badKind = await client.callTool({ name: 'orbit_list_notes',
      arguments: { workspaceId: '12345678-1234-4234-8234-123456789abc', kind: 'epic' } });
    assert.equal(badKind.isError, true);
    const failed = await client.callTool({ name: 'orbit_list_workspaces', arguments: {} });
    assert.equal(failed.isError, true);
    assert.equal(JSON.stringify(failed).includes('synthetic-test-token'), false);
  } finally { await client.close(); }
});

// ADR 007: ORBIT_API_KEY is the credential; ORBIT_ACCESS_TOKEN still works with a warning.
const KEY = 'orbit_sk_0123456789ab_' + 'S'.repeat(43);
async function withOrbit(handler, run) {
  const seen = [];
  const http = createServer((req, res) => { seen.push({ url: req.url, authorization: req.headers.authorization }); handler(req, res); });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${http.address().port}`, seen); }
  finally { await new Promise((resolve) => http.close(resolve)); }
}
async function connect(env) {
  const client = new Client({ name: 'orbit-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/orbit-mcp.mjs'], stderr: 'pipe',
    env: { PATH: process.env.PATH, ...env } });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
const json = (body, headers = {}) => (req, res) => {
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
};

test('MCP sends ORBIT_API_KEY as the bearer credential and never prints it', async () => {
  await withOrbit(json({ workspaces: [] }), async (url, seen) => {
    const { client, stderr } = await connect({ ORBIT_URL: url, ORBIT_API_KEY: KEY, ORBIT_ACCESS_TOKEN: 'synthetic-legacy-token' });
    try {
      const result = await client.callTool({ name: 'orbit_list_workspaces', arguments: {} });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, { workspaces: [] });
      assert.deepEqual(seen.map((s) => s.authorization), [`Bearer ${KEY}`], 'the API key wins over the legacy token');
      assert.equal(stderr().includes(KEY) || stderr().includes('synthetic-legacy-token'), false);
      assert.doesNotMatch(stderr(), /deprecated/);
    } finally { await client.close(); }
  });
});

test('MCP still accepts ORBIT_ACCESS_TOKEN, warning without echoing it', async () => {
  await withOrbit(json({ workspaces: [] }, { sunset: 'Thu, 19 Nov 2026 00:00:00 GMT' }), async (url, seen) => {
    const { client, stderr } = await connect({ ORBIT_URL: url, ORBIT_ACCESS_TOKEN: 'synthetic-legacy-token' });
    try {
      await client.callTool({ name: 'orbit_list_workspaces', arguments: {} });
      assert.deepEqual(seen.map((s) => s.authorization), ['Bearer synthetic-legacy-token']);
      assert.match(stderr(), /ORBIT_ACCESS_TOKEN .*deprecated. Set ORBIT_API_KEY/);
      assert.match(stderr(), /after Thu, 19 Nov 2026/);
      assert.equal(stderr().includes('synthetic-legacy-token'), false);
    } finally { await client.close(); }
  });
});

test('MCP refuses a malformed ORBIT_API_KEY without echoing it, and requires a credential', async () => {
  for (const env of [{ ORBIT_API_KEY: 'sk-not-orbit-secret-value' }, {}]) {
    const child = spawn(process.execPath, ['scripts/orbit-mcp.mjs'],
      { env: { PATH: process.env.PATH, ORBIT_URL: 'http://127.0.0.1:1', ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, /ORBIT_API_KEY/);
    assert.equal(stderr.includes('sk-not-orbit-secret-value'), false);
  }
});

// ADR 008: the adapter and the hosted /api/mcp register the same tools from lib/mcp/tools.mjs.
test('MCP adapter tools come from the shared definitions', async () => {
  const { ORBIT_TOOLS } = await import('../lib/mcp/tools.mjs');
  const { client } = await connect({ ORBIT_URL: 'http://127.0.0.1:1', ORBIT_API_KEY: KEY });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => [t.name, t.description, t.annotations.readOnlyHint]),
      ORBIT_TOOLS.map((t) => [t.name, t.description, t.readOnly]));
  } finally { await client.close(); }
});
