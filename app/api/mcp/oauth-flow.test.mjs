import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadTs } from "../../../tests/load-ts.mjs";
import { createDb, migrate, skip } from "../../../supabase/tests/harness.mjs";
import { supabaseDouble } from "../../../supabase/tests/supabase-double.mjs";
import * as tools from "../../../lib/mcp/tools.mjs";
import * as validation from "../../../lib/oauth/validation.ts";
import * as http from "../../../lib/oauth/http.ts";
import * as connections from "../../../lib/oauth/connections.ts";
import * as integrationValidation from "../../../lib/integrations/validation.ts";
import * as notes from "../../../lib/notes.ts";

// ADR 008 end to end: the real route handlers, OAuth and MCP modules over a
// PGlite database with every migration, driven by the MCP SDK's own OAuth
// client (discovery, dynamic registration, PKCE, token exchange) and its
// Streamable HTTP client. Requests go to the handlers in-process through a
// fetch router; the user's browser session is a double. Synthetic users,
// secrets and pepper only.
const ORIGIN = "https://orbit.test";
const SERVER_URL = `${ORIGIN}/api/mcp`;
const PEPPER = "synthetic-pepper-synthetic-pepper-0123";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const REDIRECT = "https://app.test/oauth/callback";
const root = new URL("../../../", import.meta.url);
const at = (path) => new URL(path, root);

let db, admin, sessionUser, logs, W1, W2, WOFF, WB;
const original = { warn: console.warn, error: console.error, info: console.info, log: console.log };

const session = () => sessionUser ? supabaseDouble(db, { role: "authenticated", user: sessionUser }) : supabaseDouble(db, { role: "anon" });
// Module graph: the real modules, with Supabase clients swapped for doubles.
const m = {};
function load() {
  const crypt = { "node:crypto": crypto };
  m.grantsConfig = loadTs(at("lib/grants/config.ts"));
  m.keys = loadTs(at("lib/grants/keys.ts"), crypt);
  m.grants = loadTs(at("lib/grants/server.ts"));
  m.audit = loadTs(at("lib/grants/audit.ts"));
  m.grantsValidation = loadTs(at("lib/grants/validation.ts"), { "@/lib/grants/server": m.grants });
  const adminModule = { createAdminClient: () => admin };
  const supabaseConfig = { authConfig: () => ({ url: "http://supabase.test", key: "publishable" }) };
  m.integrationAuth = loadTs(at("lib/integrations/auth.ts"), {
    "@supabase/supabase-js": { createClient: () => { throw new Error("user tokens are not used here"); } },
    "@/lib/supabase/config": supabaseConfig, "@/lib/supabase/admin": adminModule,
    "@/lib/grants/config": m.grantsConfig, "@/lib/grants/keys": m.keys, "@/lib/grants/server": m.grants, "@/lib/grants/audit": m.audit,
  });
  m.notesDb = loadTs(at("lib/notes-db.ts"), { "./notes": notes });
  m.routeAuth = loadTs(at("lib/supabase/route-auth.ts"), { "./server": { createClient: async () => session() }, "./config": supabaseConfig });
  m.tokens = loadTs(at("lib/oauth/tokens.ts"), crypt);
  m.oauthConfig = loadTs(at("lib/oauth/config.ts"), { "@/lib/grants/config": m.grantsConfig });
  m.metadata = loadTs(at("lib/oauth/metadata.ts"), { "@/lib/oauth/validation": validation });
  m.discovery = loadTs(at("lib/oauth/discovery.ts"), { "@/lib/oauth/config": m.oauthConfig, "@/lib/oauth/http": http,
    "@/lib/oauth/metadata": m.metadata });
  m.authorize = loadTs(at("lib/oauth/authorize.ts"), { "@/lib/oauth/validation": validation });
  m.consent = loadTs(at("lib/oauth/consent.ts"), { "@/lib/oauth/authorize": m.authorize, "@/lib/oauth/validation": validation });
  m.operations = loadTs(at("lib/mcp/operations.ts"), { "@/lib/integrations/auth": m.integrationAuth,
    "@/lib/integrations/validation": integrationValidation, "@/lib/grants/server": m.grants, "@/lib/notes": notes,
    "@/lib/notes-db": m.notesDb });
  m.mcpServer = loadTs(at("lib/mcp/server.ts"), { "@modelcontextprotocol/sdk/server/mcp.js": { McpServer },
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js": { WebStandardStreamableHTTPServerTransport },
    "@/lib/mcp/tools.mjs": tools, "@/lib/mcp/operations": m.operations });
  m.mcpAuth = loadTs(at("lib/mcp/auth.ts"), { "@/lib/supabase/admin": adminModule, "@/lib/grants/config": m.grantsConfig,
    "@/lib/grants/keys": m.keys, "@/lib/grants/server": m.grants, "@/lib/oauth/http": http, "@/lib/oauth/tokens": m.tokens,
    "@/lib/oauth/validation": validation });
  const common = { "@/lib/supabase/admin": adminModule, "@/lib/grants/config": m.grantsConfig, "@/lib/oauth/config": m.oauthConfig,
    "@/lib/oauth/http": http, "@/lib/oauth/tokens": m.tokens, "@/lib/oauth/validation": validation };
  m.routes = {
    mcp: loadTs(at("app/api/mcp/route.ts"), { ...common, "@/lib/mcp/auth": m.mcpAuth, "@/lib/mcp/server": m.mcpServer }),
    prm: loadTs(at("app/.well-known/oauth-protected-resource/route.ts"), { "@/lib/oauth/discovery": m.discovery, "@/lib/oauth/http": http }),
    prmPath: loadTs(at("app/.well-known/oauth-protected-resource/api/mcp/route.ts"), { "@/lib/oauth/discovery": m.discovery, "@/lib/oauth/http": http }),
    asm: loadTs(at("app/.well-known/oauth-authorization-server/route.ts"), { "@/lib/oauth/discovery": m.discovery, "@/lib/oauth/http": http }),
    register: loadTs(at("app/oauth/register/route.ts"), common),
    token: loadTs(at("app/oauth/token/route.ts"), common),
    revoke: loadTs(at("app/oauth/revoke/route.ts"), common),
    decision: loadTs(at("app/oauth/authorize/decision/route.ts"), { ...common, "@/lib/supabase/route-auth": m.routeAuth,
      "@/lib/oauth/authorize": m.authorize, "@/lib/oauth/consent": m.consent }),
    connections: loadTs(at("app/api/oauth/connections/route.ts"), { "@/lib/supabase/route-auth": m.routeAuth, "@/lib/oauth/connections": connections }),
    disconnect: loadTs(at("app/api/oauth/connections/[id]/disconnect/route.ts"), { "@/lib/supabase/route-auth": m.routeAuth,
      "@/lib/grants/validation": m.grantsValidation }),
    grants: loadTs(at("app/api/agent-clients/[id]/grants/route.ts"), { "@/lib/supabase/route-auth": m.routeAuth,
      "@/lib/grants/validation": m.grantsValidation, "@/lib/grants/clients": loadTs(at("lib/grants/clients.ts"), { "@/lib/supabase/route-auth": m.routeAuth }) }),
    v1notes: loadTs(at("app/api/v1/notes/route.ts"), { "@/lib/integrations/auth": m.integrationAuth,
      "@/lib/integrations/validation": integrationValidation, "@/lib/notes": notes, "@/lib/notes-db": m.notesDb }),
    v1workspaces: loadTs(at("app/api/v1/workspaces/route.ts"), { "@/lib/integrations/auth": m.integrationAuth, "@/lib/grants/server": m.grants }),
  };
}

/** The in-process "network": every request a client makes, routed to a handler. */
const seen = [];
async function router(input, init) {
  const request = input instanceof Request ? input : new Request(input, init);
  const { pathname } = new URL(request.url);
  seen.push(`${request.method} ${pathname}`);
  const r = m.routes;
  const table = {
    "/api/mcp": r.mcp, "/.well-known/oauth-protected-resource": r.prm, "/.well-known/oauth-protected-resource/api/mcp": r.prmPath,
    "/.well-known/oauth-authorization-server": r.asm, "/oauth/register": r.register, "/oauth/token": r.token, "/oauth/revoke": r.revoke,
  };
  const handler = table[pathname]?.[request.method];
  if (!handler) return new Response("Not found", { status: 404 });
  return handler(request);
}

/** An MCP client's OAuth state, as the SDK expects a provider to keep it. */
class TestProvider {
  constructor(redirect = REDIRECT) { this.redirect = redirect; this.info = undefined; this.saved = undefined; this.verifier = undefined; this.authUrl = null; }
  get redirectUrl() { return this.redirect; }
  get clientMetadata() {
    return { client_name: "Test Assistant", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return "state-123"; }
  clientInformation() { return this.info; }
  saveClientInformation(info) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens) { this.saved = tokens; }
  redirectToAuthorization(url) { this.authUrl = url; }
  saveCodeVerifier(verifier) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

/** The consent page's logic for a URL, as the signed-in (or not) user sees it. */
async function consentFor(url) {
  const endpoints = m.oauthConfig.oauthEndpoints(ORIGIN);
  const user = session();
  return m.consent.prepareConsent(new URL(url).searchParams, endpoints, {
    getClient: async (clientId) => m.consent.registeredClient((await admin.rpc("get_oauth_client", { p_client_id: clientId })).data),
    getUser: async () => (await user.auth.getUser()).data.user,
    workspaces: async () => ((await user.from("workspaces").select("id,name,agent_enabled").order("position")).data ?? [])
      .map((w) => ({ id: w.id, name: w.name, agentEnabled: w.agent_enabled })),
    currentGrants: async (clientId) => {
      const active = ((await user.rpc("list_oauth_connections")).data ?? []).find((c) => c.clientId === clientId && !c.revokedAt);
      return active ? active.grants : null;
    },
  });
}

/** Submits the consent form like the browser does. */
function decide(hidden, { decision = "allow", grants = [], origin = ORIGIN } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) if (v !== undefined) body.set(k, v);
  for (const g of grants) body.append("grant", g);
  body.set("decision", decision);
  return m.routes.decision.POST(new Request(`${ORIGIN}/oauth/authorize/decision`, {
    method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", host: "orbit.test", ...(origin ? { origin } : {}) },
  }));
}

/** Runs the SDK's OAuth flow through consent and returns the provider with tokens. */
async function connect(grants, { provider = new TestProvider() } = {}) {
  assert.equal(await sdkAuth(provider, { serverUrl: SERVER_URL, fetchFn: router }), "REDIRECT");
  const view = await consentFor(provider.authUrl);
  assert.equal(view.kind, "consent");
  const response = await decide(view.hidden, { grants: grants.map(([w, c]) => `${w}:${c}`) });
  assert.equal(response.status, 303);
  const back = new URL(response.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, provider.redirect);
  assert.equal(back.searchParams.get("state"), "state-123");
  assert.equal(back.searchParams.get("iss"), ORIGIN);
  const code = back.searchParams.get("code");
  assert.match(code, /^orbit_ac_[A-Za-z0-9_-]{43}$/);
  assert.equal(await sdkAuth(provider, { serverUrl: SERVER_URL, authorizationCode: code, fetchFn: router }), "AUTHORIZED");
  return { provider, code };
}

async function mcpClient(provider) {
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider, fetch: router }));
  return client;
}

const mcpPost = (token, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => m.routes.mcp.POST(new Request(SERVER_URL, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));
const tokenPost = (fields) => m.routes.token.POST(new Request(`${ORIGIN}/oauth/token`, {
  method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } }));
const audit = async () => (await db.query(`select principal_type, principal_id, operation, workspace_id, resource_id, outcome, code
  from public.access_audit_events order by id`)).rows;

before(async () => {
  if (skip) return;
  db = await createDb();
  await migrate(db);
  // Supabase's service role bypasses row-level security.
  await db.exec(`alter role service_role bypassrls; insert into auth.users values ('${A}'), ('${B}');`);
  let position = 0;
  const ws = async (who, name, enabled) => (await db.query(
    "insert into public.workspaces (user_id, name, agent_enabled, position) values ($1, $2, $3, $4) returning id",
    [who, name, enabled, position++])).rows[0].id;
  W1 = await ws(A, "Personal", true);
  W2 = await ws(A, "Work", true);
  WOFF = await ws(A, "Off", false);
  WB = await ws(B, "Theirs", true);
  admin = supabaseDouble(db, { role: "service_role" });
  load();
});
beforeEach(() => {
  process.env.ORBIT_API_KEY_PEPPER = PEPPER;
  delete process.env.ORBIT_OAUTH_ISSUER;
  sessionUser = A;
  logs = [];
  seen.length = 0;
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push(args.map(String).join(" "));
});
afterEach(() => Object.assign(console, original));

test("discovery: 401 challenge, protected resource and authorization server metadata, CORS", { skip }, async () => {
  const unauth = await mcpPost(null);
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("www-authenticate"),
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="orbit:read orbit:capture"`);
  assert.equal(unauth.headers.get("access-control-allow-origin"), "*");
  assert.match(unauth.headers.get("access-control-expose-headers"), /WWW-Authenticate/);
  const bad = await mcpPost("orbit_at_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("www-authenticate"),
    `Bearer error="invalid_token", error_description="The credential is invalid or expired", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="orbit:read orbit:capture"`);
  assert.equal((await mcpPost("eyJhbGciOi.some.jwt")).status, 401, "Supabase user tokens are not accepted on MCP");

  for (const route of [m.routes.prm, m.routes.prmPath]) {
    const r = await route.GET(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`));
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await r.json(), { resource: SERVER_URL, authorization_servers: [ORIGIN], scopes_supported: ["orbit:read", "orbit:capture"],
      bearer_methods_supported: ["header"], resource_name: "Orbit", resource_documentation: `${ORIGIN}/settings/agents/setup#connect-apps` });
  }
  const as = await (await m.routes.asm.GET(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json();
  assert.equal(as.issuer, ORIGIN);
  assert.equal(as.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(as.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.equal(as.revocation_endpoint, `${ORIGIN}/oauth/revoke`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  // Preflights: any origin, never credentials.
  for (const route of [m.routes.mcp, m.routes.token, m.routes.register, m.routes.revoke, m.routes.prm, m.routes.asm]) {
    const r = route.OPTIONS();
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-credentials"), null);
    assert.match(r.headers.get("access-control-allow-headers"), /Authorization/);
  }
  // HTTP (non-localhost) origins are refused for OAuth.
  const plain = await m.routes.asm.GET(new Request("http://orbit.example/.well-known/oauth-authorization-server"));
  assert.equal(plain.status, 400);
});

test("the full flow: DCR, consent, PKCE token, MCP tools, refresh rotation, reuse detection, revoke", { skip }, async () => {
  const { provider } = await connect([[W1, "workspace.read"], [W1, "item.write"], [W2, "workspace.read"]]);
  assert.match(provider.info.client_id, /^orbit_ci_[0-9a-f]{32}$/);
  assert.equal(provider.info.token_endpoint_auth_method, "none");
  assert.match(provider.saved.access_token, /^orbit_at_/);
  assert.match(provider.saved.refresh_token, /^orbit_rt_/);
  assert.equal(provider.saved.expires_in, 3600);
  assert.equal(provider.saved.scope, "orbit:read orbit:capture");
  assert.ok(seen.includes("POST /oauth/register") && seen.includes("GET /.well-known/oauth-authorization-server"));

  const client = await mcpClient(provider);
  try {
    const { tools: list } = await client.listTools();
    assert.deepEqual(list.map((t) => t.name), ["orbit_list_workspaces", "orbit_list_notes", "orbit_capture_note"]);
    // The same schemas and descriptions as the stdio adapter (one source of truth).
    for (const t of list) assert.equal(t.description, tools.ORBIT_TOOLS.find((d) => d.name === t.name).description);
    assert.deepEqual(list.find((t) => t.name === "orbit_list_notes").inputSchema.properties.kind.enum, ["note", "task", "project", "document", "followup"]);
    const spaces = await client.callTool({ name: "orbit_list_workspaces", arguments: {} });
    assert.deepEqual(spaces.structuredContent.workspaces.map((w) => [w.name, w.capabilities]),
      [["Personal", ["item.write", "workspace.read"]], ["Work", ["workspace.read"]]]);
    const captured = await client.callTool({ name: "orbit_capture_note", arguments: { workspaceId: W1, title: " Synthetic capture ", text: "Synthetic body" } });
    assert.notEqual(captured.isError, true);
    assert.equal(captured.structuredContent.bucket, "inbox");
    const row = (await db.query("select user_id, workspace_id, title, bucket, kind, revision from public.notes where id = $1",
      [captured.structuredContent.id])).rows[0];
    assert.deepEqual({ ...row, revision: Number(row.revision) }, { user_id: A, workspace_id: W1, title: "Synthetic capture", bucket: "inbox", kind: "note", revision: 1 });
    const read = await client.callTool({ name: "orbit_list_notes", arguments: { workspaceId: W1, kind: "note" } });
    assert.ok(read.structuredContent.notes.some((n) => n.id === captured.structuredContent.id));
    // Grants per tool and workspace.
    const noCapture = await client.callTool({ name: "orbit_capture_note", arguments: { workspaceId: W2, title: "x", text: "y" } });
    assert.equal(noCapture.isError, true);
    assert.match(noCapture.content[0].text, /^capability_denied: .*Capture/);
    const other = await client.callTool({ name: "orbit_list_notes", arguments: { workspaceId: WB } });
    assert.match(other.content[0].text, /^capability_denied/, "another user's workspace looks like any ungranted one");
  } finally {
    await client.close();
  }
  const connection = (await db.query("select id from public.agent_clients where auth_kind = 'oauth'")).rows[0].id;
  const rows = await audit();
  assert.deepEqual(rows.map((r) => [r.principal_type, r.principal_id, r.operation, r.workspace_id, r.outcome, r.code]), [
    ["agent_client", connection, "workspace.list", null, "allowed", null],
    ["agent_client", connection, "item.create", W1, "allowed", null],
    ["agent_client", connection, "item.read", W1, "allowed", null],
    ["agent_client", connection, "item.create", W2, "denied", "capability_denied"],
    ["agent_client", connection, "item.read", WB, "denied", "capability_denied"],
  ]);
  assert.equal(JSON.stringify(rows).includes("Synthetic"), false, "audit rows are content-free");

  // Refresh rotation, then reuse detection revokes the family.
  const clientId = provider.info.client_id;
  const firstRefresh = provider.saved.refresh_token;
  const rotated = await tokenPost({ grant_type: "refresh_token", refresh_token: firstRefresh, client_id: clientId, resource: SERVER_URL });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.headers.get("cache-control"), "no-store");
  const second = await rotated.json();
  assert.notEqual(second.refresh_token, firstRefresh);
  assert.equal((await mcpPost(second.access_token)).status, 200);
  const reuse = await tokenPost({ grant_type: "refresh_token", refresh_token: firstRefresh, client_id: clientId });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal((await mcpPost(second.access_token)).status, 401, "the whole family is revoked");
  assert.equal((await mcpPost(provider.saved.access_token)).status, 401);
  assert.equal((await tokenPost({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId })).status, 400);

  // Reconnect (consent pre-ticks the current grants), then RFC 7009 revoke → 401.
  const again = new TestProvider();
  again.info = provider.info;
  assert.equal(await sdkAuth(again, { serverUrl: SERVER_URL, fetchFn: router }), "REDIRECT");
  const view = await consentFor(again.authUrl);
  assert.equal(view.reconnecting, true);
  assert.deepEqual(view.checked.sort(), [`${W1}:item.write`, `${W1}:workspace.read`, `${W2}:workspace.read`].sort());
  const ok = await decide(view.hidden, { grants: [`${W1}:workspace.read`] });
  const code = new URL(ok.headers.get("location")).searchParams.get("code");
  assert.equal(await sdkAuth(again, { serverUrl: SERVER_URL, authorizationCode: code, fetchFn: router }), "AUTHORIZED");
  assert.equal((await mcpPost(again.saved.access_token)).status, 200);
  assert.equal((await db.query("select count(*)::int n from public.agent_clients where auth_kind = 'oauth'")).rows[0].n, 1, "reused");
  const revoked = await m.routes.revoke.POST(new Request(`${ORIGIN}/oauth/revoke`, { method: "POST",
    body: new URLSearchParams({ token: again.saved.refresh_token, client_id: clientId, token_type_hint: "refresh_token" }),
    headers: { "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(revoked.status, 200);
  assert.equal((await mcpPost(again.saved.access_token)).status, 401);
  const unknown = await m.routes.revoke.POST(new Request(`${ORIGIN}/oauth/revoke`, { method: "POST",
    body: new URLSearchParams({ token: "orbit_rt_" + "z".repeat(43), client_id: clientId }), headers: { "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(unknown.status, 200, "unknown tokens answer 200 too");
});

test("authorization request errors: client, redirect, PKCE, resource, scope; signed-out and Deny", { skip }, async () => {
  const provider = new TestProvider();
  await sdkAuth(provider, { serverUrl: SERVER_URL, fetchFn: router });
  const url = new URL(provider.authUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), SERVER_URL);
  const variant = (changes) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(changes)) v === null ? u.searchParams.delete(k) : u.searchParams.set(k, v);
    return u.toString();
  };
  const errorOf = (result) => (assert.equal(result.kind, "redirect"), new URL(result.url).searchParams.get("error"));
  // Never redirect for an unknown client or an unregistered redirect URI.
  assert.equal((await consentFor(variant({ client_id: "orbit_ci_" + "0".repeat(32) }))).kind, "invalid");
  assert.equal((await consentFor(variant({ redirect_uri: "https://evil.test/cb" }))).kind, "invalid");
  assert.equal((await consentFor(variant({ redirect_uri: `${REDIRECT}/` }))).kind, "invalid", "exact match only");
  const dup = new URL(url);
  dup.searchParams.append("redirect_uri", REDIRECT);
  assert.equal((await consentFor(dup)).kind, "invalid", "repeated parameters");
  // Errors go back to the verified redirect URI with state and iss.
  const missing = await consentFor(variant({ code_challenge: null }));
  assert.equal(errorOf(missing), "invalid_request");
  assert.equal(new URL(missing.url).searchParams.get("state"), "state-123");
  assert.equal(new URL(missing.url).searchParams.get("iss"), ORIGIN);
  assert.equal(errorOf(await consentFor(variant({ code_challenge_method: "plain" }))), "invalid_request");
  assert.equal(errorOf(await consentFor(variant({ code_challenge_method: null }))), "invalid_request", "plain is the default");
  assert.equal(errorOf(await consentFor(variant({ resource: "https://evil.test/api/mcp" }))), "invalid_target");
  assert.equal(errorOf(await consentFor(variant({ response_type: "token" }))), "unsupported_response_type");
  assert.equal(errorOf(await consentFor(variant({ scope: "admin" }))), "invalid_scope");
  assert.equal((await consentFor(variant({ resource: "HTTPS://ORBIT.TEST/api/mcp/" }))).kind, "consent", "case and trailing slash");
  assert.equal((await consentFor(variant({ resource: null }))).kind, "consent", "an absent resource means this server");
  const readOnly = await consentFor(variant({ scope: "orbit:read offline_access" }));
  assert.deepEqual(readOnly.columns.map((c) => c.label), ["Read"]);
  // Signed out: to /login with this request as a safe relative next.
  sessionUser = null;
  const login = await consentFor(url);
  assert.equal(login.kind, "login");
  const next = new URL(login.url, ORIGIN).searchParams.get("next");
  assert.equal(validation.safeNext(next), next);
  assert.ok(next.startsWith("/oauth/authorize?client_id="));
  sessionUser = A;
  // The consent screen: name, redirect host, spaces with the kill switch flagged.
  const view = await consentFor(url);
  assert.equal(view.clientName, "Test Assistant");
  assert.equal(view.redirectHost, "app.test");
  assert.equal(view.loopback, false);
  assert.deepEqual(view.workspaces.map((w) => [w.name, w.agentEnabled]), [["Personal", true], ["Work", true], ["Off", false]]);
  assert.equal(view.workspaces.some((w) => w.id === WB), false, "only the user's own spaces");
  // Deny → access_denied at the redirect URI; nothing is created.
  const before = (await db.query("select count(*)::int n from public.oauth_authorization_codes")).rows[0].n;
  const denied = await decide(view.hidden, { decision: "deny" });
  assert.equal(denied.status, 303);
  const back = new URL(denied.headers.get("location"));
  assert.deepEqual([back.searchParams.get("error"), back.searchParams.get("state"), back.searchParams.get("iss")], ["access_denied", "state-123", ORIGIN]);
  assert.equal((await db.query("select count(*)::int n from public.oauth_authorization_codes")).rows[0].n, before);
  // Allow with nothing ticked goes back to the consent screen.
  const empty = await decide(view.hidden, { grants: [] });
  assert.match(empty.headers.get("location"), /^\/oauth\/authorize\?.*&notice=choose$/);
  // Tampered hidden fields are checked again; another user's space is refused; cross-site posts are refused.
  assert.equal((await decide({ ...view.hidden, redirect_uri: "https://evil.test/cb" }, { grants: [`${W1}:workspace.read`] })).status, 400);
  assert.equal((await decide(view.hidden, { grants: [`${WB}:workspace.read`] })).status, 400);
  assert.equal((await decide(view.hidden, { grants: [`${W1}:workspace.read`], origin: "https://evil.test" })).status, 403);
  assert.equal((await decide(view.hidden, { grants: [`${W1}:workspace.read`], origin: null })).status, 403);
  sessionUser = null;
  assert.equal((await decide(view.hidden, { grants: [`${W1}:workspace.read`] })).status, 401);
});

test("token endpoint errors: wrong verifier, wrong redirect, reused or expired code, wrong resource", { skip }, async () => {
  const provider = new TestProvider();
  await sdkAuth(provider, { serverUrl: SERVER_URL, fetchFn: router });
  const consentAndCode = async () => {
    const p = new TestProvider();
    p.info = provider.info;
    await sdkAuth(p, { serverUrl: SERVER_URL, fetchFn: router });
    const view = await consentFor(p.authUrl);
    const r = await decide(view.hidden, { grants: [`${W1}:workspace.read`] });
    return { code: new URL(r.headers.get("location")).searchParams.get("code"), verifier: p.verifier };
  };
  const exchange = (code, verifier, extra = {}) => tokenPost({ grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: REDIRECT, client_id: provider.info.client_id, resource: SERVER_URL, ...extra });
  const errorOf = async (response) => [response.status, (await response.json()).error];

  const a = await consentAndCode();
  assert.deepEqual(await errorOf(await exchange(a.code, crypto.randomBytes(32).toString("base64url"))), [400, "invalid_grant"]);
  assert.deepEqual(await errorOf(await exchange(a.code, a.verifier)), [400, "invalid_grant"], "a failed verifier burns the code");
  const b = await consentAndCode();
  assert.deepEqual(await errorOf(await exchange(b.code, b.verifier, { redirect_uri: "https://app.test/other" })), [400, "invalid_grant"]);
  const c = await consentAndCode();
  assert.deepEqual(await errorOf(await exchange(c.code, c.verifier, { resource: "https://evil.test/api/mcp" })), [400, "invalid_target"]);
  assert.deepEqual(await errorOf(await exchange(c.code, "short")), [400, "invalid_grant"]);
  const d = await consentAndCode();
  const issued = await exchange(d.code, d.verifier);
  assert.equal(issued.status, 200);
  const tokens = await issued.json();
  assert.equal((await mcpPost(tokens.access_token)).status, 200);
  assert.deepEqual(await errorOf(await exchange(d.code, d.verifier)), [400, "invalid_grant"], "a code is single-use");
  assert.equal((await mcpPost(tokens.access_token)).status, 401, "replaying the code revokes what it issued");
  const e = await consentAndCode();
  await db.query("update public.oauth_authorization_codes set expires_at = now() - interval '1 second'");
  assert.deepEqual(await errorOf(await exchange(e.code, e.verifier)), [400, "invalid_grant"], "expired");
  assert.deepEqual(await errorOf(await tokenPost({ grant_type: "password", client_id: provider.info.client_id })), [400, "unsupported_grant_type"]);
  assert.deepEqual(await errorOf(await tokenPost({ grant_type: "authorization_code", code: "x" })), [401, "invalid_client"]);
  // Access tokens are audience-bound: a token for this resource is checked against this resource only.
  const f = await consentAndCode();
  const fTokens = await (await exchange(f.code, f.verifier)).json();
  await db.query("update public.oauth_tokens set resource = 'https://other.test/api/mcp' where kind = 'access'");
  assert.equal((await mcpPost(fTokens.access_token)).status, 401);
  // No code, token, verifier or pepper in any log line.
  const everything = logs.join("\n");
  for (const value of [a.code, d.code, tokens.access_token, tokens.refresh_token, d.verifier, PEPPER])
    assert.equal(everything.includes(value), false);
  assert.ok(logs.some((l) => l.includes(provider.info.client_id)), "logs name the client id");
});

test("registration: https redirect URIs only (localhost allowed), metadata limits, rate limit per IP", { skip }, async () => {
  const register = (body, ip = "203.0.113.7") => m.routes.register.POST(new Request(`${ORIGIN}/oauth/register`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` } }));
  const ok = await register({ client_name: "Grok‮", redirect_uris: ["http://127.0.0.1:4567/cb", "https://grok.com/connectors/cb"],
    logo_uri: "http://insecure.test/logo.png", client_uri: "https://grok.com", token_endpoint_auth_method: "client_secret_post" });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.client_name, "Grok", "control characters are stripped");
  assert.equal(body.token_endpoint_auth_method, "none", "public clients only");
  assert.equal(body.logo_uri, undefined, "a non-https logo is dropped");
  assert.equal(body.client_secret, undefined);
  assert.equal(ok.headers.get("access-control-allow-origin"), "*");
  for (const [uris, error] of [[["http://evil.test/cb"], "invalid_redirect_uri"], [["https://a.test/cb#x"], "invalid_redirect_uri"],
    [["javascript:alert(1)"], "invalid_redirect_uri"], [[], "invalid_redirect_uri"]]) {
    const r = await register({ redirect_uris: uris });
    assert.deepEqual([r.status, (await r.json()).error], [400, error], uris.join());
  }
  assert.equal((await register({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).status, 400);
  assert.equal((await register({ redirect_uris: [REDIRECT], response_types: ["token"] })).status, 400);
  let last;
  for (let i = 0; i < 10; i++) last = await register({ redirect_uris: [REDIRECT] }, "198.51.100.9");
  assert.equal(last.status, 201);
  const limited = await register({ redirect_uris: [REDIRECT] }, "198.51.100.9");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "3600");
  assert.equal((await register({ redirect_uris: [REDIRECT] }, "198.51.100.10")).status, 201);
  const stored = JSON.stringify((await db.query("select to_jsonb(c) j from public.oauth_clients c")).rows);
  assert.equal(stored.includes("198.51.100.9") || stored.includes("203.0.113.7"), false, "no IP address is stored");
  // A loopback app gets the extra warning on the consent screen.
  const local = new TestProvider("http://localhost:33418/callback");
  await sdkAuth(local, { serverUrl: SERVER_URL, fetchFn: router });
  const view = await consentFor(local.authUrl);
  assert.equal(view.loopback, true);
  assert.equal(view.redirectHost, "localhost:33418");
});

test("API keys work on /api/mcp with the same grants, and match /api/v1's results", { skip }, async () => {
  const key = m.keys.generateApiKey(PEPPER);
  const created = await supabaseDouble(db, { role: "authenticated", user: A }).rpc("create_agent_client", {
    p_name: "Script", p_key_prefix: key.prefix, p_key_hash: key.hash,
    p_grants: [{ workspaceId: W1, capability: "workspace.read" }, { workspaceId: WOFF, capability: "workspace.read" }] });
  assert.equal(created.data.status, "created");
  const client = new Client({ name: "key-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    fetch: router, requestInit: { headers: { Authorization: `Bearer ${key.key}` } } }));
  try {
    const v1 = await (await m.routes.v1workspaces.GET(new Request(`${ORIGIN}/api/v1/workspaces`, { headers: { authorization: `Bearer ${key.key}` } }))).json();
    const viaMcp = await client.callTool({ name: "orbit_list_workspaces", arguments: {} });
    assert.deepEqual(viaMcp.structuredContent, v1, "the same workspaces and capabilities as /api/v1");
    const v1notes = await (await m.routes.v1notes.GET(new Request(`${ORIGIN}/api/v1/notes?workspaceId=${W1}&limit=10`,
      { headers: { authorization: `Bearer ${key.key}` } }))).json();
    const mcpNotes = await client.callTool({ name: "orbit_list_notes", arguments: { workspaceId: W1, limit: 10 } });
    assert.deepEqual(mcpNotes.structuredContent, v1notes, "the same notes as /api/v1");
    const off = await client.callTool({ name: "orbit_list_notes", arguments: { workspaceId: WOFF } });
    assert.match(off.content[0].text, /^agent_disabled/, "the kill switch still wins");
    const capture = await client.callTool({ name: "orbit_capture_note", arguments: { workspaceId: W1, title: "t", text: "x" } });
    assert.match(capture.content[0].text, /^capability_denied/);
  } finally {
    await client.close();
  }
  await supabaseDouble(db, { role: "authenticated", user: A }).rpc("revoke_agent_client", { p_id: created.data.client.id });
  const revoked = await mcpPost(key.key);
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get("www-authenticate"), /error="invalid_token", error_description="This API key has been revoked"/);
  assert.ok(logs.some((l) => l.includes(`orbit_sk_${key.prefix}`)) && !logs.join().includes(key.key));
});

test("Settings: connected apps listed apart from keys, grant edits apply next request, disconnect revokes tokens", { skip }, async () => {
  const { provider } = await connect([[W2, "workspace.read"]]);
  const settings = (path, init = {}) => new Request(`${ORIGIN}${path}`, { ...init, headers: { host: "orbit.test", origin: ORIGIN, "content-type": "application/json", ...init.headers } });
  const listed = await (await m.routes.connections.GET(settings("/api/oauth/connections"))).json();
  const mine = listed.connections.filter((c) => !c.revokedAt && c.grants.some((g) => g.workspaceId === W2));
  assert.equal(mine.length, 1);
  const app = mine[0];
  assert.deepEqual([app.name, app.redirectHosts], ["Test Assistant", ["app.test"]]);
  assert.equal(JSON.stringify(listed).match(/orbit_(at|rt|ac)_|token_hash|code_hash/), null, "metadata only");
  const keyRoute = loadTs(at("app/api/agent-clients/route.ts"), { "@/lib/supabase/route-auth": m.routeAuth, "@/lib/grants/config": m.grantsConfig,
    "@/lib/grants/keys": m.keys, "@/lib/grants/validation": m.grantsValidation,
    "@/lib/grants/clients": loadTs(at("lib/grants/clients.ts"), { "@/lib/supabase/route-auth": m.routeAuth }) });
  const keys = await (await keyRoute.GET(settings("/api/agent-clients"))).json();
  assert.equal(keys.clients.some((c) => c.id === app.id), false, "connected apps are not listed as API keys");

  const call = async (token, args) => {
    const r = await mcpPost(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "orbit_list_notes", arguments: args } });
    return (await r.json()).result;
  };
  const token = provider.saved.access_token;
  assert.notEqual((await call(token, { workspaceId: W2 })).isError, true);
  const edit = await m.routes.grants.PUT(settings(`/api/agent-clients/${app.id}/grants`, { method: "PUT",
    body: JSON.stringify({ grants: [{ workspaceId: W1, capability: "workspace.read" }] }) }), { params: Promise.resolve({ id: app.id }) });
  assert.equal(edit.status, 200);
  assert.equal((await call(token, { workspaceId: W2 })).isError, true, "the removed grant applies on the next request");
  assert.notEqual((await call(token, { workspaceId: W1 })).isError, true);

  assert.equal((await m.routes.disconnect.POST(settings(`/api/oauth/connections/${app.id}/disconnect`, { method: "POST", headers: { origin: "https://evil.test" } }),
    { params: Promise.resolve({ id: app.id }) })).status, 403);
  sessionUser = B;
  assert.equal((await m.routes.disconnect.POST(settings(`/api/oauth/connections/${app.id}/disconnect`, { method: "POST" }),
    { params: Promise.resolve({ id: app.id }) })).status, 404, "only the owner");
  sessionUser = A;
  const off = await m.routes.disconnect.POST(settings(`/api/oauth/connections/${app.id}/disconnect`, { method: "POST" }), { params: Promise.resolve({ id: app.id }) });
  assert.equal(off.status, 200);
  const after = await mcpPost(token);
  assert.equal(after.status, 401);
  assert.match(after.headers.get("www-authenticate"), /error="invalid_token"/);
  const refresh = await tokenPost({ grant_type: "refresh_token", refresh_token: provider.saved.refresh_token, client_id: provider.info.client_id });
  assert.equal(refresh.status, 400, "the refresh token is revoked too");
  const tokens = (await db.query("select revoke_reason from public.oauth_tokens where agent_client_id = $1", [app.id])).rows;
  assert.ok(tokens.length >= 2 && tokens.every((t) => t.revoke_reason === "disconnected"));
});

test("misconfiguration fails closed without echoing secrets", { skip }, async () => {
  delete process.env.ORBIT_API_KEY_PEPPER;
  const r = await mcpPost("orbit_at_" + "q".repeat(43));
  assert.equal(r.status, 503);
  assert.ok(logs.some((l) => l.includes("ORBIT_API_KEY_PEPPER is not set")));
  process.env.ORBIT_API_KEY_PEPPER = PEPPER;
  process.env.ORBIT_OAUTH_ISSUER = "https://orbit.example.com/path";
  assert.equal((await m.routes.asm.GET(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).status, 400);
  process.env.ORBIT_OAUTH_ISSUER = "https://pinned.example";
  assert.equal((await (await m.routes.asm.GET(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json()).issuer, "https://pinned.example");
  const get = await m.routes.mcp.GET(new Request(SERVER_URL));
  assert.equal(get.status, 401, "GET also asks for credentials first");
});
