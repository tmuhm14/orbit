// Workflow definitions: a graph of steps the designer draws and the engine
// (./engine.ts) walks. Pure: no React, no Next, no database.
//
// A definition is stored as one jsonb document per workflow. Step config is
// user-authored intent (prompts, conditions); outputs produced while running
// are data, never instructions.

export const WORKFLOW_VERSION = 1;
export const MAX_NODES = 60;
export const MAX_EDGES = 120;
export const LABEL_MAX = 80;
export const PROMPT_MAX = 4000;
export const TEXT_MAX = 500;
/** Canvas bounds; positions outside are clamped. */
export const CANVAS_EXTENT = 20_000;

/**
 * Step kinds. `tone` picks the card color: the same seven families the
 * Archify diagrams use (frontend, backend, database, cloud, security,
 * messagebus, external).
 */
export const NODE_KINDS = {
  trigger: { label: "Trigger", tone: "frontend", ports: ["next"], hint: "Starts the workflow" },
  agent: { label: "Agent task", tone: "backend", ports: ["next"], hint: "An agent works on a prompt" },
  condition: { label: "Condition", tone: "cloud", ports: ["yes", "no"], hint: "Branches on the previous result" },
  approval: { label: "Approval", tone: "security", ports: ["approved", "rejected"], hint: "Waits for your review" },
  action: { label: "Create item", tone: "database", ports: ["next"], hint: "Saves a result as an Orbit item" },
  delay: { label: "Delay", tone: "messagebus", ports: ["next"], hint: "Waits before continuing" },
  end: { label: "End", tone: "external", ports: [], hint: "Finishes the workflow" },
} as const;

export type NodeKind = keyof typeof NODE_KINDS;
export type Tone = (typeof NODE_KINDS)[NodeKind]["tone"];
export const isNodeKind = (value: unknown): value is NodeKind =>
  typeof value === "string" && Object.hasOwn(NODE_KINDS, value);
export const portsOf = (kind: NodeKind): readonly string[] => NODE_KINDS[kind].ports;

export const TRIGGER_MODES = ["manual", "item_captured"] as const;
export const CONDITION_OPERATORS = ["contains", "not_contains", "is_empty", "not_empty"] as const;
export const ACTION_BUCKETS = ["inbox", "next", "reference", "someday"] as const;

export type NodeConfig = {
  trigger: { mode: (typeof TRIGGER_MODES)[number] };
  /** `{{previous}}` in the prompt is replaced by the previous step's output. */
  agent: { prompt: string };
  condition: { operator: (typeof CONDITION_OPERATORS)[number]; value: string };
  approval: { instructions: string };
  action: { title: string; bucket: (typeof ACTION_BUCKETS)[number] };
  delay: { minutes: number };
  end: Record<string, never>;
};

export type WorkflowNode = {
  [K in NodeKind]: { id: string; kind: K; label: string; x: number; y: number; config: NodeConfig[K] };
}[NodeKind];

export type WorkflowEdge = { id: string; from: string; to: string; port: string };

export type WorkflowDefinition = {
  version: typeof WORKFLOW_VERSION;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

/** A saved workflow as the API returns it. */
export type Workflow = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export function defaultConfig<K extends NodeKind>(kind: K): NodeConfig[K] {
  const configs: NodeConfig = {
    trigger: { mode: "manual" },
    agent: { prompt: "" },
    condition: { operator: "contains", value: "" },
    approval: { instructions: "" },
    action: { title: "{{previous}}", bucket: "inbox" },
    delay: { minutes: 60 },
    end: {},
  };
  return configs[kind];
}

let counter = 0;
/** Short, collision-resistant ids for nodes and edges inside one definition. */
export function newId(prefix: string) {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createNode<K extends NodeKind>(kind: K, x: number, y: number): WorkflowNode {
  return { id: newId(kind), kind, label: NODE_KINDS[kind].label, x: Math.round(x), y: Math.round(y), config: defaultConfig(kind) } as WorkflowNode;
}

/** A new workflow: a manual trigger, one agent task and an end. */
export function starterDefinition(): WorkflowDefinition {
  const trigger = createNode("trigger", 80, 200);
  const agent = createNode("agent", 380, 200);
  const end = createNode("end", 680, 200);
  return {
    version: WORKFLOW_VERSION,
    nodes: [trigger, { ...agent, label: "Draft a summary" }, end],
    edges: [
      { id: newId("edge"), from: trigger.id, to: agent.id, port: "next" },
      { id: newId("edge"), from: agent.id, to: end.id, port: "next" },
    ],
  };
}

// --- Parsing (structure) -----------------------------------------------------

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : null;
const clamp = (value: number) => Math.max(-CANVAS_EXTENT, Math.min(CANVAS_EXTENT, Math.round(value)));
const oneOf = <T extends readonly string[]>(list: T, value: unknown): value is T[number] =>
  typeof value === "string" && list.includes(value);

function parseConfig(kind: NodeKind, value: unknown): NodeConfig[NodeKind] | null {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  switch (kind) {
    case "trigger":
      return oneOf(TRIGGER_MODES, input.mode) ? { mode: input.mode } : null;
    case "agent": {
      const prompt = text(input.prompt ?? "", PROMPT_MAX);
      return prompt === null ? null : { prompt };
    }
    case "condition": {
      const v = text(input.value ?? "", TEXT_MAX);
      return oneOf(CONDITION_OPERATORS, input.operator) && v !== null ? { operator: input.operator, value: v } : null;
    }
    case "approval": {
      const instructions = text(input.instructions ?? "", TEXT_MAX);
      return instructions === null ? null : { instructions };
    }
    case "action": {
      const title = text(input.title ?? "", TEXT_MAX);
      return title !== null && oneOf(ACTION_BUCKETS, input.bucket) ? { title, bucket: input.bucket } : null;
    }
    case "delay": {
      const minutes = Number(input.minutes);
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10_080 ? { minutes } : null;
    }
    case "end":
      return {};
  }
}

/**
 * A well-formed definition, or null. Checks shape and limits only: a draft
 * may still have problems the designer reports (validateWorkflow).
 */
export function parseDefinition(value: unknown): WorkflowDefinition | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.version !== WORKFLOW_VERSION || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) return null;
  if (input.nodes.length > MAX_NODES || input.edges.length > MAX_EDGES) return null;
  const nodes: WorkflowNode[] = [];
  const ids = new Set<string>();
  for (const raw of input.nodes) {
    if (!raw || typeof raw !== "object") return null;
    const node = raw as Record<string, unknown>;
    const label = text(node.label, LABEL_MAX);
    if (typeof node.id !== "string" || !ID.test(node.id) || ids.has(node.id) || !isNodeKind(node.kind) ||
        label === null || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return null;
    const config = parseConfig(node.kind, node.config);
    if (!config) return null;
    ids.add(node.id);
    nodes.push({ id: node.id, kind: node.kind, label, x: clamp(node.x as number), y: clamp(node.y as number), config } as WorkflowNode);
  }
  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  for (const raw of input.edges) {
    if (!raw || typeof raw !== "object") return null;
    const edge = raw as Record<string, unknown>;
    if (typeof edge.id !== "string" || !ID.test(edge.id) || edgeIds.has(edge.id) ||
        typeof edge.from !== "string" || !ids.has(edge.from) ||
        typeof edge.to !== "string" || !ids.has(edge.to) || typeof edge.port !== "string") return null;
    edgeIds.add(edge.id);
    edges.push({ id: edge.id, from: edge.from, to: edge.to, port: edge.port });
  }
  return { version: WORKFLOW_VERSION, nodes, edges };
}

// --- Validation (meaning) ----------------------------------------------------

export type WorkflowIssue = { severity: "error" | "warning"; message: string; nodeId?: string; edgeId?: string };

/** Problems that block a run (errors) or are worth a look (warnings). */
export function validateWorkflow(definition: WorkflowDefinition): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  const triggers = definition.nodes.filter((n) => n.kind === "trigger");
  if (triggers.length === 0) issues.push({ severity: "error", message: "Add a trigger to start the workflow" });
  for (const extra of triggers.slice(1))
    issues.push({ severity: "error", message: "A workflow has one trigger", nodeId: extra.id });

  const seenPorts = new Set<string>();
  for (const edge of definition.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      issues.push({ severity: "error", message: "A connection points at a missing step", edgeId: edge.id });
      continue;
    }
    if (edge.from === edge.to) issues.push({ severity: "error", message: "A step can't connect to itself", edgeId: edge.id });
    if (!portsOf(from.kind).includes(edge.port))
      issues.push({ severity: "error", message: `“${from.label}” has no “${edge.port}” output`, edgeId: edge.id });
    if (to.kind === "trigger") issues.push({ severity: "error", message: "Nothing can lead into the trigger", edgeId: edge.id });
    const key = `${edge.from}:${edge.port}`;
    if (seenPorts.has(key))
      issues.push({ severity: "error", message: `“${from.label}” connects its “${edge.port}” output twice`, edgeId: edge.id });
    seenPorts.add(key);
  }

  for (const node of definition.nodes) {
    if (node.kind === "agent" && !node.config.prompt.trim())
      issues.push({ severity: "error", message: `“${node.label}” needs a prompt`, nodeId: node.id });
    if (node.kind === "action" && !node.config.title.trim())
      issues.push({ severity: "error", message: `“${node.label}” needs an item title`, nodeId: node.id });
    if (node.kind === "condition" && (node.config.operator === "contains" || node.config.operator === "not_contains") && !node.config.value.trim())
      issues.push({ severity: "error", message: `“${node.label}” needs text to look for`, nodeId: node.id });
    for (const port of portsOf(node.kind))
      if (!seenPorts.has(`${node.id}:${port}`))
        issues.push({
          severity: "warning",
          message: portsOf(node.kind).length > 1
            ? `“${node.label}” has nothing on its “${port}” branch; the run ends there`
            : `“${node.label}” isn't connected to a next step`,
          nodeId: node.id,
        });
  }

  if (hasCycle(definition)) issues.push({ severity: "error", message: "Steps loop back on themselves; remove a connection" });

  if (triggers.length === 1) {
    const reached = reachable(definition, triggers[0].id);
    for (const node of definition.nodes)
      if (!reached.has(node.id))
        issues.push({ severity: "warning", message: `“${node.label}” can't be reached from the trigger`, nodeId: node.id });
  }
  return issues;
}

export const runnable = (issues: WorkflowIssue[]) => !issues.some((i) => i.severity === "error");

export function outgoing(definition: WorkflowDefinition, nodeId: string): WorkflowEdge[] {
  return definition.edges.filter((e) => e.from === nodeId);
}

function reachable(definition: WorkflowDefinition, start: string) {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of outgoing(definition, id))
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
  }
  return seen;
}

function hasCycle(definition: WorkflowDefinition) {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const edge of outgoing(definition, id)) {
      const next = state.get(edge.to);
      if (next === 1 || (next === undefined && visit(edge.to))) return true;
    }
    state.set(id, 2);
    return false;
  };
  return definition.nodes.some((n) => !state.has(n.id) && visit(n.id));
}

// --- Editing helpers (used by the designer) ---------------------------------

/** Connects `from`'s `port` to `to`, replacing what that output led to before. */
export function connect(definition: WorkflowDefinition, from: string, port: string, to: string): WorkflowDefinition {
  if (from === to) return definition;
  const edges = definition.edges.filter((e) => !(e.from === from && e.port === port));
  return { ...definition, edges: [...edges, { id: newId("edge"), from, to, port }] };
}

export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.filter((n) => n.id !== nodeId),
    edges: definition.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/** `{{previous}}` → the previous step's output (data, inserted as text). */
export function fillTemplate(template: string, previous: string) {
  return template.replace(/\{\{\s*previous\s*\}\}/g, previous);
}

// --- Templates ----------------------------------------------------------------

type Draft = { kind: NodeKind; label: string; x: number; y: number; config?: Partial<NodeConfig[NodeKind]> };

function build(drafts: Draft[], links: [number, number, string?][]): WorkflowDefinition {
  const nodes = drafts.map((d) => {
    const node = createNode(d.kind, d.x, d.y);
    return { ...node, label: d.label, config: { ...node.config, ...d.config } } as WorkflowNode;
  });
  return {
    version: WORKFLOW_VERSION,
    nodes,
    edges: links.map(([from, to, port = "next"]) => ({ id: newId("edge"), from: nodes[from].id, to: nodes[to].id, port })),
  };
}

export const WORKFLOW_TEMPLATES = [
  { id: "starter", name: "Blank workflow", description: "A trigger, one agent task and an end.", create: starterDefinition },
  {
    id: "research",
    name: "Research with review",
    description: "An agent researches, you approve, and the brief is saved to Reference.",
    create: () => build(
      [
        { kind: "trigger", label: "Run on demand", x: 60, y: 200 },
        { kind: "agent", label: "Research the topic", x: 320, y: 200, config: { prompt: "Research this and write a short brief with sources:\n\n{{previous}}" } },
        { kind: "approval", label: "Review the brief", x: 580, y: 200, config: { instructions: "Check the brief is accurate before saving." } },
        { kind: "action", label: "Save to Reference", x: 840, y: 120, config: { title: "{{previous}}", bucket: "reference" } },
        { kind: "end", label: "Done", x: 1100, y: 200 },
      ],
      [[0, 1], [1, 2], [2, 3, "approved"], [2, 4, "rejected"], [3, 4]],
    ),
  },
  {
    id: "triage",
    name: "Triage new captures",
    description: "Classify each capture; urgent ones get a next action drafted.",
    create: () => build(
      [
        { kind: "trigger", label: "Item captured", x: 60, y: 220, config: { mode: "item_captured" } },
        { kind: "agent", label: "Classify urgency", x: 320, y: 220, config: { prompt: "Reply URGENT or ROUTINE for this capture, then one line why:\n\n{{previous}}" } },
        { kind: "condition", label: "Is it urgent?", x: 580, y: 220, config: { operator: "contains", value: "urgent" } },
        { kind: "agent", label: "Draft next action", x: 840, y: 110, config: { prompt: "Write the single next physical action for:\n\n{{previous}}" } },
        { kind: "action", label: "Add to Next", x: 1100, y: 110, config: { title: "{{previous}}", bucket: "next" } },
        { kind: "end", label: "Done", x: 1360, y: 220 },
      ],
      [[0, 1], [1, 2], [2, 3, "yes"], [2, 5, "no"], [3, 4], [4, 5]],
    ),
  },
] as const;
