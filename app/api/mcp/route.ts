import { requestEndpoints } from "@/lib/oauth/config";
import { oauthError, oauthJson, preflight, withCors } from "@/lib/oauth/http";
import { mcpAuth } from "@/lib/mcp/auth";
import { handleMcpRequest } from "@/lib/mcp/server";

// The hosted MCP server (ADR 008): stateless Streamable HTTP. Authenticate
// with an Orbit OAuth access token (cloud apps such as Grok and Claude) or an
// Orbit API key (scripted clients). Without either: 401 with a
// WWW-Authenticate challenge naming the protected resource metadata.
export const runtime = "nodejs";
export const maxDuration = 60;

const notHttps = () => oauthError("invalid_request", "Orbit's MCP server requires HTTPS", 400);

export async function POST(request: Request) {
  const endpoints = requestEndpoints(request);
  if (!endpoints) return notHttps();
  const auth = await mcpAuth(request, endpoints);
  if ("error" in auth) return auth.error;
  try {
    return withCors(await handleMcpRequest(request, auth));
  } catch {
    // No request content in logs: the client and a fixed message only.
    console.error(JSON.stringify({ event: "mcp.request_failed", credential: auth.principal.type === "agent_client" ? auth.principal.label : null }));
    return oauthJson({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
  }
}

/** No server-initiated stream in stateless mode (MCP Streamable HTTP §GET). */
async function notAllowed(request: Request) {
  const endpoints = requestEndpoints(request);
  if (!endpoints) return notHttps();
  const auth = await mcpAuth(request, endpoints);
  if ("error" in auth) return auth.error;
  return oauthJson({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405,
    { Allow: "POST, OPTIONS" });
}

export async function GET(request: Request) {
  return notAllowed(request);
}

export async function DELETE(request: Request) {
  return notAllowed(request);
}

export function OPTIONS() {
  return preflight();
}
