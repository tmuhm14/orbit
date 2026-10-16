import { resourceMetadataResponse } from "@/lib/oauth/discovery";
import { preflight } from "@/lib/oauth/http";

// RFC 9728 protected resource metadata for /api/mcp (ADR 008). The 401 from
// /api/mcp points here.
export async function GET(request: Request) {
  return resourceMetadataResponse(request);
}

export function OPTIONS() {
  return preflight();
}
