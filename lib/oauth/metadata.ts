import type { OAuthEndpoints } from "@/lib/oauth/config";
import { SCOPES } from "@/lib/oauth/validation";

/** RFC 9728 protected resource metadata for /api/mcp. */
export const protectedResourceMetadata = (e: OAuthEndpoints) => ({
  resource: e.resource,
  authorization_servers: [e.issuer],
  scopes_supported: [...SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: "Orbit",
  resource_documentation: e.documentation,
});

/** RFC 8414 authorization server metadata. Public clients with PKCE S256 only. */
export const authorizationServerMetadata = (e: OAuthEndpoints) => ({
  issuer: e.issuer,
  authorization_endpoint: e.authorization,
  token_endpoint: e.token,
  registration_endpoint: e.registration,
  revocation_endpoint: e.revocation,
  scopes_supported: [...SCOPES],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  // RFC 9207: authorization responses carry iss.
  authorization_response_iss_parameter_supported: true,
  service_documentation: e.documentation,
});
