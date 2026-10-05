import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/supabase/config";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const path =
        request.nextUrl.searchParams.get("next") === "reset"
          ? "/auth/reset-password"
          : "/";
      const response = NextResponse.redirect(new URL(path, siteUrl()));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", siteUrl()));
}
