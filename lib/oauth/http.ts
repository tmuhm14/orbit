/**
 * HTTP helpers for the OAuth and MCP endpoints (ADR 008). CORS allows any
 * origin, because MCP clients may run in a browser, and never credentials:
 * these endpoints take bearer tokens or public client ids, never cookies.
 */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "600",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/** JSON with CORS; OAuth responses are never cached (RFC 6749 §5.1). */
export const oauthJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache", ...headers } });

export const oauthError = (error: string, description: string, status = 400, headers: Record<string, string> = {}) =>
  oauthJson({ error, error_description: description }, status, headers);

/** Adds CORS to a response from elsewhere (the MCP transport). */
export function withCors(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The body as text, at most `limit` bytes; null when larger. Content-Length is not trusted. */
async function readText(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Reads a form-encoded (OAuth's format) or JSON body of at most `limit` bytes
 * into string fields. Null when it is too large or malformed, or a form field
 * repeats (RFC 6749 §3.2).
 */
export async function readFields(request: Request, limit = 16_384): Promise<Record<string, string> | null> {
  const text = await readText(request, limit);
  if (text === null) return null;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") fields[key] = value;
      return fields;
    } catch {
      return null;
    }
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    if (key in fields) return null;
    fields[key] = value;
  }
  return fields;
}

/** All values of a form body, for repeated checkbox fields. Null when too large. */
export async function readForm(request: Request, limit = 65_536): Promise<URLSearchParams | null> {
  const text = await readText(request, limit);
  return text === null ? null : new URLSearchParams(text);
}

/** A JSON body of at most `limit` bytes; undefined when too large or malformed. */
export async function readJson(request: Request, limit = 16_384): Promise<unknown> {
  const text = await readText(request, limit);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
