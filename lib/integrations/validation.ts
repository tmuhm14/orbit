export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function captureInput(value: unknown): value is { workspaceId: string; title: string; text: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.workspaceId === "string" && uuid.test(v.workspaceId) &&
    typeof v.title === "string" && v.title.trim().length > 0 && v.title.length <= 2000 &&
    typeof v.text === "string" && v.text.length <= 50_000 &&
    Object.keys(v).every(key => ["workspaceId", "title", "text"].includes(key));
}
