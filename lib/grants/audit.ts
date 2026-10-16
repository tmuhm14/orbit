import "server-only";
import type { Principal } from "@/lib/grants/server";

/**
 * Content-free access audit (ADR 004 §5): principal, operation, workspace,
 * resource id, outcome. Never titles, text, payloads, keys or tokens.
 */

export type AccessOperation = "workspace.list" | "item.read" | "item.create";
export type AccessEvent = {
  userId: string;
  principal: Principal;
  operation: AccessOperation;
  workspaceId?: string | null;
  resourceId?: string | null;
  outcome: "allowed" | "denied";
  code?: "capability_denied" | "agent_disabled" | "client_revoked" | null;
};

type Rpc = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }> };

/**
 * Writes one audit row through record_access_event (service role only).
 * Fails open: an audit failure logs a fixed line and does not block the
 * operation it describes.
 */
export async function recordAccess(admin: Rpc | null, event: AccessEvent) {
  if (!admin) {
    console.error("access audit unavailable: server role not configured");
    return;
  }
  try {
    const { error } = await admin.rpc("record_access_event", {
      p_user_id: event.userId,
      p_principal_type: event.principal.type,
      p_principal_id: event.principal.type === "agent_client" ? event.principal.clientId : null,
      p_operation: event.operation,
      p_workspace_id: event.workspaceId ?? null,
      p_resource_id: event.resourceId ?? null,
      p_outcome: event.outcome,
      p_code: event.code ?? null,
    });
    if (error) throw new Error("audit write failed");
  } catch {
    console.error("access audit write failed");
  }
}
