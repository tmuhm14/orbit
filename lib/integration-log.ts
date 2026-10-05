import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type IntegrationEvent = {
  source: "slack" | "email";
  status: "captured" | "duplicate" | "unlinked" | "ignored" | "error";
  detail?: string;
  userId?: string;
  workspaceId?: string;
};

/** Records a capture outcome for the admin health view. Never throws. */
export async function logIntegrationEvent(
  admin: SupabaseClient,
  event: IntegrationEvent,
) {
  try {
    await admin.from("integration_events").insert({
      source: event.source,
      status: event.status,
      detail: event.detail?.slice(0, 500) ?? null,
      user_id: event.userId ?? null,
      workspace_id: event.workspaceId ?? null,
    });
  } catch {
    /* Logging must never break a capture. */
  }
}
