"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { WORKFLOW_TEMPLATES, validateWorkflow, runnable } from "@/lib/workflows/model";
import { workflowHref } from "@/lib/workspace-routes";
import { WorkflowPreview } from "./workflow-graph";
import { useWorkspaceWorkflows } from "./use-workflows";
import { useWorkspaceShell } from "./workspace-shell-context";

const updated = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** /workflows: the space's workflows and templates to start new ones. */
export function WorkflowsPage() {
  const { workspaceId, showToast } = useWorkspaceShell();
  const router = useRouter();
  const { workflows, error, create, remove } = useWorkspaceWorkflows(workspaceId);
  const [creating, setCreating] = useState<string | null>(null);

  async function start(template: (typeof WORKFLOW_TEMPLATES)[number]) {
    setCreating(template.id);
    try {
      const workflow = await create(template.id === "starter" ? "Untitled workflow" : template.name, template.create());
      router.push(workflowHref(workflow.id));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not create workflow");
      setCreating(null);
    }
  }

  async function del(id: string, name: string) {
    if (!window.confirm(`Delete “${name}”? This can't be undone.`)) return;
    try {
      await remove(id);
      showToast("Workflow deleted");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete workflow");
    }
  }

  return (
    <main className="workflows-page">
      <header className="workflows-header">
        <div className="workflows-mark"><WorkflowIcon size={24} /></div>
        <div>
          <div className="eyebrow">AGENT WORKFLOWS</div>
          <h1>Workflows</h1>
          <p>Chain agent tasks, conditions and approvals on a canvas, then test-run them step by step.</p>
        </div>
      </header>

      <section aria-labelledby="wf-templates">
        <h2 id="wf-templates" className="workflows-section-title">Start from</h2>
        <div className="wf-template-grid">
          {WORKFLOW_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="wf-template"
              disabled={!!creating}
              onClick={() => start(template)}
            >
              <span className="wf-card-canvas">
                <WorkflowPreview definition={template.create()} />
              </span>
              <span className="wf-card-body">
                <strong>
                  {creating === template.id ? <LoaderCircle className="wf-spin" size={14} /> : template.id === "starter" && <Plus size={14} />}
                  {template.name}
                </strong>
                <small>{template.description}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="wf-yours">
        <h2 id="wf-yours" className="workflows-section-title">
          In this space <span>{workflows?.length ?? "–"}</span>
        </h2>
        {error && <p className="wf-error" role="alert">{error}</p>}
        {workflows === null ? (
          <p className="wf-muted"><LoaderCircle className="wf-spin" size={14} /> Loading workflows…</p>
        ) : workflows.length === 0 ? (
          <div className="empty-state">
            <h3>No workflows yet</h3>
            <p>Pick a template above to open the designer.</p>
          </div>
        ) : (
          <ul className="wf-list">
            {workflows.map((workflow) => {
              const ready = runnable(validateWorkflow(workflow.definition));
              return (
                <li key={workflow.id} className="wf-list-item">
                  <button type="button" className="wf-list-open" onClick={() => router.push(workflowHref(workflow.id))}>
                    <span className="wf-card-canvas">
                      <WorkflowPreview definition={workflow.definition} />
                    </span>
                    <span className="wf-card-body">
                      <strong>{workflow.name}</strong>
                      <small>
                        <span className={`wf-ready ${ready ? "is-ready" : ""}`}>{ready ? "Ready" : "Draft"}</span>
                        {workflow.definition.nodes.length} steps · Edited {updated(workflow.updatedAt)}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button wf-list-delete"
                    aria-label={`Delete ${workflow.name}`}
                    title="Delete workflow"
                    onClick={() => del(workflow.id, workflow.name)}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
