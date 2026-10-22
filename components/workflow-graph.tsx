"use client";

import { NODE_KINDS, portsOf, type WorkflowDefinition, type WorkflowNode } from "@/lib/workflows/model";

// Geometry shared by the designer canvas and the list's previews. Cards sit
// at (x, y) with their input on the left edge and outputs down the right.
export const NODE_W = 212;
export const NODE_H = 76;

export const inputPoint = (node: Pick<WorkflowNode, "x" | "y">) => ({ x: node.x, y: node.y + NODE_H / 2 });

export function outputPoint(node: WorkflowNode, port: string) {
  const ports = portsOf(node.kind);
  const index = Math.max(0, ports.indexOf(port));
  return { x: node.x + NODE_W, y: node.y + (NODE_H * (index + 1)) / (ports.length + 1) };
}

/** A horizontal cubic from an output to an input, bowing out for back-links. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const bend = Math.max(48, Math.abs(to.x - from.x) * 0.45, from.x > to.x ? 140 : 0);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** The point halfway along edgePath (t = 0.5 of the cubic), for label chips. */
export function edgeMidpoint(from: { x: number; y: number }, to: { x: number; y: number }) {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

export function bounds(definition: WorkflowDefinition, pad = 40) {
  if (!definition.nodes.length) return { x: 0, y: 0, width: 800, height: 400 };
  const xs = definition.nodes.map((n) => n.x);
  const ys = definition.nodes.map((n) => n.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) + NODE_W + pad - minX,
    height: Math.max(...ys) + NODE_H + pad - minY,
  };
}

/** A small static rendering of a workflow, in the canvas's colors. */
export function WorkflowPreview({ definition }: { definition: WorkflowDefinition }) {
  const box = bounds(definition);
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="wf-preview"
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {definition.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        return <path key={edge.id} className="wf-preview-edge" d={edgePath(outputPoint(from, edge.port), inputPoint(to))} />;
      })}
      {definition.nodes.map((node) => (
        <g key={node.id} className={`wf-tone-${NODE_KINDS[node.kind].tone}`}>
          <rect className="wf-preview-node" x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={12} />
          <rect className="wf-preview-bar" x={node.x + 18} y={node.y + 22} width={64} height={8} rx={4} />
          <rect className="wf-preview-line" x={node.x + 18} y={node.y + 42} width={NODE_W - 60} height={10} rx={5} />
        </g>
      ))}
    </svg>
  );
}
