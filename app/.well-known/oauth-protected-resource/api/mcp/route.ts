import { resourceMetadataResponse } from "@/lib/oauth/discovery";
import { preflight } from "@/lib/oauth/http";

// The path-suffixed form of the protected resource metadata (RFC 9728 §3.1):
// clients that don't read WWW-Authenticate try this before the root.
export async function GET(request: Request) {
  return resourceMetadataResponse(request);
}

export function OPTIONS() {
  return preflight();
}
