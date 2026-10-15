import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAgentSettings } from "@/lib/agent/server";
import { isAssignmentUuid } from "@/lib/assignments/validation";
import { assignmentError, authFailure } from "@/lib/assignments/server";
import { assignmentAvailability } from "@/lib/assignments/documents";

/**
 * Whether the built-in executor can run in one of the caller's workspaces:
 * `?workspaceId=<uuid>` → `{ available: true }` or `{ available: false,
 * reason: "agent_disabled" | "no_key" | "key_unreadable" }`. The same checks
 * the executor's preflight makes (workspace switch, a saved key that
 * decrypts). Nothing about the key (ciphertext, hint, provider) is returned.
 */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return authFailure(auth.error);
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!isAssignmentUuid(workspaceId)) return assignmentError("invalid_payload");
  const { data: workspace, error } = await auth.supabase
    .from("workspaces")
    .select("id,agent_enabled")
    .eq("id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle<{ id: string; agent_enabled: boolean }>();
  if (error) return assignmentError("load_failed");
  if (!workspace) return assignmentError("not_found");
  if (!workspace.agent_enabled) return json(assignmentAvailability(false, null));
  // agent_settings has no browser policies; only the admin client reads it.
  const admin = createAdminClient();
  if (!admin) return assignmentError("not_configured");
  let settings: { apiKey: string | null } | null;
  try {
    settings = await loadAgentSettings(admin, auth.user.id);
  } catch {
    return assignmentError("load_failed");
  }
  return json(assignmentAvailability(true, settings && { apiKey: settings.apiKey }));
}
