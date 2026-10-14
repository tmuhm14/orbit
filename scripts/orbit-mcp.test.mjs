import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
