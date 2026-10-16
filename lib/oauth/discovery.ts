import { requestEndpoints } from "@/lib/oauth/config";
import { oauthError, oauthJson } from "@/lib/oauth/http";
import { authorizationServerMetadata, protectedResourceMetadata } from "@/lib/oauth/metadata";

/**
 * GET handlers for the discovery documents, shared by the root and the
 * path-suffixed protected resource metadata routes (MCP authorization,
 * "Protected Resource Metadata Discovery"). Public, cross-origin, cacheable
 * for five minutes.
 */

const CACHE = { "Cache-Control": "public, max-age=300" };

export function resourceMetadataResponse(request: Request) {
  const endpoints = requestEndpoints(request);
  if (!endpoints) return oauthError("invalid_request", "OAuth requires HTTPS");
  return oauthJson(protectedResourceMetadata(endpoints), 200, CACHE);
}

export function authorizationServerResponse(request: Request) {
  const endpoints = requestEndpoints(request);
  if (!endpoints) return oauthError("invalid_request", "OAuth requires HTTPS");
  return oauthJson(authorizationServerMetadata(endpoints), 200, CACHE);
}
