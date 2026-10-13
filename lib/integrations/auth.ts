import "server-only";
import { createClient } from "@supabase/supabase-js";
import { authConfig } from "@/lib/supabase/config";

export const reply = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

/** Bearer-only integration auth. Never falls back to browser cookies or admin access. */
export async function integrationUser(request: Request) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return { error: reply({ error: "A Supabase user access token is required" }, 401) } as const;
  const config = authConfig();
  if (!config) return { error: reply({ error: "Not configured" }, 503) } as const;
  const supabase = createClient(config.url, config.key, {
    global: { headers: { Authorization: `Bearer ${match[1]}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.getUser(match[1]);
  if (error || !data.user) return { error: reply({ error: "Invalid or expired access token" }, 401) } as const;
  return { supabase, user: data.user } as const;
}
