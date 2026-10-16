import { CAPABILITIES, type Capability } from "@/lib/grants/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GrantInput = { workspaceId: string; capability: Capability };

/** [{workspaceId, capability}], deduplicated; null when anything is malformed. */
export function grantsInput(value: unknown): GrantInput[] | null {
  if (!Array.isArray(value) || value.length > 300) return null;
  const seen = new Map<string, GrantInput>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const g = item as Record<string, unknown>;
    if (Object.keys(g).some((k) => k !== "workspaceId" && k !== "capability")) return null;
    if (typeof g.workspaceId !== "string" || !UUID.test(g.workspaceId)) return null;
    if (typeof g.capability !== "string" || !(CAPABILITIES as readonly string[]).includes(g.capability)) return null;
    const workspaceId = g.workspaceId.toLowerCase();
    seen.set(`${workspaceId}:${g.capability}`, { workspaceId, capability: g.capability as Capability });
  }
  return [...seen.values()];
}

/** {name, grants}: name 1–100 characters after trimming. */
export function clientInput(value: unknown): { name: string; grants: GrantInput[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== "name" && k !== "grants")) return null;
  if (typeof v.name !== "string") return null;
  const name = v.name.trim();
  if (name.length < 1 || name.length > 100) return null;
  const grants = grantsInput(v.grants ?? []);
  return grants ? { name, grants } : null;
}

export const isUuid = (value: string) => UUID.test(value);
