// The workflow engine: walks a definition from its trigger, one step at a
// time, through the output each step chooses. Pure and runtime-agnostic: the
// side effects (calling an agent, waiting for a review, saving an item) are
// handlers the caller provides, so the designer's test run and a durable
// server run share this one walker.
import {
  fillTemplate,
  outgoing,
  runnable,
  validateWorkflow,
  type NodeConfig,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./model.ts";

export type StepStatus = "running" | "succeeded" | "failed";

export type StepRecord = {
  nodeId: string;
  kind: WorkflowNode["kind"];
  status: StepStatus;
  /** The output the step took; null when it ended the run. */
  port: string | null;
  /** Step output text: data, never instructions. */
  output: string;
  startedAt: number;
  finishedAt: number | null;
};

export type RunOutcome = {
  status: "completed" | "failed" | "invalid";
  steps: StepRecord[];
  /** A fixed, content-free reason when status isn't completed. */
  error: string | null;
};

type Handler<K extends keyof NodeConfig> = (
  node: Extract<WorkflowNode, { kind: K }>,
  input: { previous: string },
) => Promise<{ output: string; port?: string }>;

/** Effects the run needs. Missing handlers fall back to pass-through behavior. */
export type RunHandlers = {
  agent: Handler<"agent">;
  approval: Handler<"approval">;
  action?: Handler<"action">;
  delay?: Handler<"delay">;
};

export type RunOptions = {
  /** Text the trigger hands to the first step (an item's content, say). */
  input?: string;
  maxSteps?: number;
  /** Called after each change, for live progress. */
  onStep?: (steps: StepRecord[]) => void;
  /** Checked before every step; a true value stops the run. */
  canceled?: () => boolean;
  now?: () => number;
};

/** Pure: the branch a condition takes for the previous output. */
export function evaluateCondition(config: NodeConfig["condition"], previous: string): "yes" | "no" {
  const haystack = previous.toLowerCase();
  const needle = config.value.trim().toLowerCase();
  const result =
    config.operator === "contains" ? haystack.includes(needle)
      : config.operator === "not_contains" ? !haystack.includes(needle)
        : config.operator === "is_empty" ? !previous.trim()
          : !!previous.trim();
  return result ? "yes" : "no";
}

export async function runWorkflow(
  definition: WorkflowDefinition,
  handlers: RunHandlers,
  { input = "", maxSteps = 100, onStep, canceled, now = Date.now }: RunOptions = {},
): Promise<RunOutcome> {
  const steps: StepRecord[] = [];
  if (!runnable(validateWorkflow(definition))) return { status: "invalid", steps, error: "invalid_definition" };
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  let node: WorkflowNode | undefined = definition.nodes.find((n) => n.kind === "trigger");
  let previous = input;
  const emit = () => onStep?.(steps.map((s) => ({ ...s })));

  while (node) {
    if (steps.length >= maxSteps) return { status: "failed", steps, error: "step_limit" };
    if (canceled?.()) return { status: "failed", steps, error: "canceled" };
    const record: StepRecord = {
      nodeId: node.id, kind: node.kind, status: "running", port: null, output: "", startedAt: now(), finishedAt: null,
    };
    steps.push(record);
    emit();
    let result: { output: string; port?: string };
    try {
      result = await runStep(node, previous, handlers);
    } catch {
      record.status = "failed";
      record.finishedAt = now();
      emit();
      return { status: "failed", steps, error: "step_failed" };
    }
    const ports = outgoing(definition, node.id);
    const port = result.port ?? (ports[0]?.port ?? null);
    record.status = "succeeded";
    record.output = result.output;
    record.port = node.kind === "end" ? null : port;
    record.finishedAt = now();
    emit();
    previous = result.output;
    const edge = ports.find((e) => e.port === port);
    node = edge ? byId.get(edge.to) : undefined;
  }
  return { status: "completed", steps, error: null };
}

async function runStep(node: WorkflowNode, previous: string, handlers: RunHandlers) {
  switch (node.kind) {
    case "trigger":
    case "end":
      return { output: previous };
    case "agent":
      return handlers.agent(node, { previous });
    case "condition":
      return { output: previous, port: evaluateCondition(node.config, previous) };
    case "approval": {
      const result = await handlers.approval(node, { previous });
      return { output: result.output, port: result.port === "rejected" ? "rejected" : "approved" };
    }
    case "action":
      return handlers.action
        ? handlers.action(node, { previous })
        : { output: fillTemplate(node.config.title, previous) };
    case "delay":
      return handlers.delay ? handlers.delay(node, { previous }) : { output: previous };
  }
}
