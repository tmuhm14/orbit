"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo } from "react";
import { ChevronDown, ListChecks, Plus } from "lucide-react";
import { itemKind, projectsIn } from "@/lib/notes";
import { projectPathLabel } from "@/lib/item-properties";
import { tasksEmptyCopy, tasksView } from "@/lib/tasks-view";
import { TASK_FILTERS, parseTasksParams, projectHref, tasksHref } from "@/lib/workspace-routes";
import { useLocalToday } from "./due-items";
import { useAssignmentIndex } from "./use-assignment-index";
import { TaskRow, WorkEmpty, WorkHeader } from "./work-rows";
import { useWorkspaceShell } from "./workspace-shell-context";

const DUE_GROUPS = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
] as const;

/**
 * Tasks (`/tasks`): actionable items in this space, filtered by
 * `?filter=next|due|waiting|completed` and optionally `?project=<id>`
 * (the project and everything nested in it). Filters are links, so browser
 * back/forward and shared URLs restore them.
 */
export function TasksPage() {
  const { notes, workspaceId, loadError, assignmentsVersion, createItem } = useWorkspaceShell();
  const params = parseTasksParams(useSearchParams());
  const router = useRouter();
  const today = useLocalToday();
  const index = useAssignmentIndex(workspaceId, assignmentsVersion);
  const projectId = useId();
  const project = params.project
    ? notes.find((n) => n.id === params.project && n.workspaceId === workspaceId && itemKind(n) === "project")
    : undefined;
  const { filter, project: projectParam } = params;
  const view = useMemo(
    () => (today ? tasksView(notes, workspaceId, { filter, project: projectParam }, today) : null),
    [notes, workspaceId, filter, projectParam, today],
  );
  // Every project in the space, by full path.
  const projects = useMemo(
    () =>
      projectsIn(notes, workspaceId)
        .map((p) => ({ id: p.id, path: projectPathLabel(notes, p.id) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [notes, workspaceId],
  );
  const empty = tasksEmptyCopy(params.filter, !!params.project);
  const filterLabel = TASK_FILTERS.find((f) => f.id === params.filter)!.label;
  const row = (n: (typeof notes)[number]) => (
    <TaskRow key={n.id} note={n} today={today} assignment={index.forNote(n.id)} showProject={!project || n.projectId !== project.id} />
  );

  let body;
  if (loadError) body = <p className="work-state" role="alert">Your tasks couldn’t be loaded. Reload the page to try again.</p>;
  else if (params.project && !project)
    body = (
      <WorkEmpty title="That project isn’t here" body="It may have been deleted, or it belongs to another space.">
        <Link className="secondary-button" href={tasksHref({ filter: params.filter })}>Show all tasks</Link>
      </WorkEmpty>
    );
  else if (!view) body = <p className="work-state" role="status">Loading tasks…</p>;
  else if (!view.items.length)
    body = (
      <WorkEmpty title={empty.title} body={empty.body}>
        {params.filter === "next" && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => createItem({ kind: "task", bucket: "next", projectId: project?.id ?? null })}
          >
            <Plus size={14} aria-hidden="true" /> Add a task
          </button>
        )}
      </WorkEmpty>
    );
  else if (view.groups)
    body = DUE_GROUPS.map(({ id, label }) =>
      view.groups![id].length ? (
        <section key={id} className={`work-section is-${id}`} aria-labelledby={`tasks-${id}`}>
          <h2 id={`tasks-${id}`}>
            {label}
            <span className="work-count">{view.groups![id].length}</span>
          </h2>
          <ul className="work-list">{view.groups![id].map(row)}</ul>
        </section>
      ) : null,
    );
  else
    body = (
      <section className="work-section" aria-labelledby="tasks-list-heading">
        <h2 id="tasks-list-heading" className="sr-only">
          {filterLabel}
        </h2>
        <ul className="work-list">{view.items.map(row)}</ul>
      </section>
    );

  return (
    <main className="work-page tasks-page">
      <WorkHeader
        icon={<ListChecks size={22} />}
        eyebrow="WORK AND FOLLOW-UPS"
        title="Tasks"
        description={
          project ? (
            <>
              In <Link href={projectHref(project.id)}>{project.title.trim() || "Untitled project"}</Link> and its sub-projects.
            </>
          ) : (
            "Next actions, deadlines and what you’re waiting on."
          )
        }
        actions={
          <button
            type="button"
            className="primary-button small"
            disabled={loadError}
            onClick={() => createItem({ kind: "task", bucket: "next", projectId: project?.id ?? null })}
          >
            <Plus size={15} aria-hidden="true" /> New task
          </button>
        }
      />
      <div className="work-toolbar">
        <nav className="work-filters" aria-label="Task filters">
          <ul>
            {TASK_FILTERS.map((f) => {
              const selected = f.id === params.filter;
              return (
                <li key={f.id}>
                  <Link
                    href={tasksHref({ filter: f.id, project: params.project })}
                    scroll={false}
                    className={`work-filter ${selected ? "is-selected" : ""}`}
                    aria-current={selected ? "page" : undefined}
                  >
                    {f.label}
                    {view && <span className="work-count" aria-label={`, ${view.counts[f.id]} items`}>{view.counts[f.id]}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        {projects.length > 0 && (
          <div className="work-select">
            <label htmlFor={projectId}>Project</label>
            <div className="select-wrap">
              <select
                id={projectId}
                value={project?.id ?? ""}
                onChange={(e) => router.push(tasksHref({ filter: params.filter, project: e.target.value || null }), { scroll: false })}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.path}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
        )}
      </div>
      <p className="sr-only" role="status">
        {view ? `${filterLabel}: ${view.items.length} ${view.items.length === 1 ? "item" : "items"}` : ""}
      </p>
      <div className="work-body" aria-busy={!view && !loadError}>
        {body}
      </div>
    </main>
  );
}
