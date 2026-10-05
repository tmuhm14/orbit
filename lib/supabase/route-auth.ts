import "server-only";
import { createClient } from "./server";
import { authConfig } from "./config";

const noStore = { "Cache-Control": "private, no-store" };
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: noStore });

// Session cookies are SameSite=Lax, which already blocks most cross-site
// writes; also require a same-origin Origin header on anything that mutates.
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  try {
    return !!origin && !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Returns a Supabase client scoped to the signed-in user, or an error response. */
export async function routeUser(request: Request, { mutating = false } = {}) {
  if (mutating && !sameOrigin(request))
    return { error: json({ error: "Forbidden" }, 403) } as const;
  if (!authConfig())
    return { error: json({ error: "Not configured" }, 503) } as const;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: json({ error: "Signed out" }, 401) } as const;
  return { supabase, user } as const;
}
