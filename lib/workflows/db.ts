// Rows of public.workflows ↔ the API's Workflow shape, and request parsing for
// the /api/workflows routes. Pure, so the routes stay thin and testable.
import { parseDefinition, starterDefinition, type Workflow, type WorkflowDefinition } from "./model.ts";

export const WORKFLOW_COLUMNS = "id,workspace_id,name,description,definition,revision,created_at,updated_at";
/** Per workspace. */
export const WORKFLOW_LIMIT = 50;

export type WorkflowRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  definition: unknown;
  revision: number;
  created_at: string;
  updated_at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** A stored definition that no longer parses opens as an empty canvas. */
export function workflowFromRow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    definition: parseDefinition(row.definition) ?? { version: 1, nodes: [], edges: [] },
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const name = (value: unknown) =>
  typeof value === "string" && value.trim() && value.trim().length <= 80 ? value.trim() : null;
const description = (value: unknown) =>
  typeof value === "string" && value.length <= 500 ? value.trim() : null;

export type CreateInput = { workspaceId: string; name: string; description: string; definition: WorkflowDefinition };

export function parseCreate(value: unknown): CreateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const n = name(input.name);
  const d = description(input.description ?? "");
  const definition = input.definition === undefined ? starterDefinition() : parseDefinition(input.definition);
  if (!isUuid(input.workspaceId) || !n || d === null || !definition) return null;
  return { workspaceId: input.workspaceId, name: n, description: d, definition };
}

export type UpdateInput = {
  revision: number;
  changes: { name?: string; description?: string; definition?: WorkflowDefinition };
};

/** A change needs the revision it was made against and at least one field. */
export function parseUpdate(value: unknown): UpdateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!Number.isInteger(input.revision) || (input.revision as number) < 1) return null;
  const changes: UpdateInput["changes"] = {};
  if (input.name !== undefined) {
    const n = name(input.name);
    if (!n) return null;
    changes.name = n;
  }
  if (input.description !== undefined) {
    const d = description(input.description);
    if (d === null) return null;
    changes.description = d;
  }
  if (input.definition !== undefined) {
    const definition = parseDefinition(input.definition);
    if (!definition) return null;
    changes.definition = definition;
  }
  if (!Object.keys(changes).length) return null;
  return { revision: input.revision as number, changes };
}
