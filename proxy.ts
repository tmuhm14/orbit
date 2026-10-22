import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig, cookieOptions } from "@/lib/supabase/config";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const config = authConfig();
  if (config) {
    const supabase = createServerClient(config.url, config.key, {
      cookieOptions,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          values.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });
    await supabase.auth.getUser();
  }
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  // The OAuth consent screen (ADR 008) must never be framed: a framed Allow
  // button could be clickjacked.
  if (request.nextUrl.pathname.startsWith("/oauth/")) {
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  }
  return response;
}
export const config = {
  matcher: [
    "/",
    "/settings",
    "/settings/:path*",
    "/scheduled",
    "/agents",
    "/tasks",
    "/projects/:path*",
    "/library",
    "/items/:path*",
    "/workflows/:path*",
    "/login",
    "/oauth/authorize",
    "/oauth/authorize/:path*",
    "/auth/:path*",
    "/slack/:path*",
    "/api/notes/:path*",
    "/api/workspaces/:path*",
    "/api/scheduled-tasks/:path*",
    "/api/workflows/:path*",
    "/api/workflow-runs/:path*",
    "/api/slack-links",
  ],
};
