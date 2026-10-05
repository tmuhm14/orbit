import "server-only";
import { createClient } from "@supabase/supabase-js";
import { authConfig } from "./config";

// Bypasses row-level security. Only for server routes that act without a
// signed-in browser (Slack callbacks) and must check ownership themselves.
export function createAdminClient() {
  const config = authConfig();
  const secret =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!config || !secret) return null;
  return createClient(config.url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
