import { authorizationServerResponse } from "@/lib/oauth/discovery";
import { preflight } from "@/lib/oauth/http";

// RFC 8414 authorization server metadata (ADR 008). The issuer is this
// origin, so this is the issuer's well-known URL with no path to insert.
export async function GET(request: Request) {
  return authorizationServerResponse(request);
}

export function OPTIONS() {
  return preflight();
}
