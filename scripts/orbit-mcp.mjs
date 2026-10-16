import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerOrbitTools } from '../lib/mcp/tools.mjs';

const base = new URL(process.env.ORBIT_URL || 'http://localhost:3000');
if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
  (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))))
  throw new Error('ORBIT_URL must be an HTTPS origin (localhost HTTP is allowed)');
// Credentials (ADR 007): an Orbit API key from Settings → Agents & API keys.
// ORBIT_ACCESS_TOKEN (a Supabase user token) still works (deprecated), with
// a warning recommending a key. Neither value is ever printed.
const apiKey = process.env.ORBIT_API_KEY?.trim();
const legacyToken = process.env.ORBIT_ACCESS_TOKEN?.trim();
if (apiKey && !/^orbit_sk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(apiKey))
  throw new Error('ORBIT_API_KEY is not an Orbit API key (expected orbit_sk_...). Create one in Settings → Agents & API keys.');
if (!apiKey && !legacyToken)
  throw new Error('Set ORBIT_API_KEY to an Orbit API key (Settings → Agents & API keys)');
if (!apiKey)
  console.error('Warning: ORBIT_ACCESS_TOKEN (a Supabase user token) is deprecated. Set ORBIT_API_KEY to an Orbit API key (Settings → Agents & API keys) for scoped, revocable access.');
const token = apiKey || legacyToken;

// The tools, their schemas and descriptions are shared with the hosted
// endpoint (/api/mcp): lib/mcp/tools.mjs is the one source of truth.
export function createOrbitServer(call) {
  const server = new McpServer({ name: 'orbit-mcp-server', version: '1.0.0' });
  return registerOrbitTools(server, async (tool, args) => ({ result: await call(tool.http.path, tool.http.method, args) }));
}

const server = createOrbitServer(async (path, method, args) => {
  const url = new URL(path, base);
  if (method === 'GET') for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(args) } : {}),
  });
  const sunset = response.headers.get('sunset');
  if (sunset && !warnedSunset) {
    warnedSunset = true;
    console.error(`Warning: Orbit will stop accepting this credential after ${sunset}. Set ORBIT_API_KEY.`);
  }
  if (!response.ok) throw new Error('Orbit request failed');
  return response.json();
});
let warnedSunset = false;
await server.connect(new StdioServerTransport());
