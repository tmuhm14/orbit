"use client";

import Link from "next/link";
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  FileText,
  Layers,
  ListChecks,
  Maximize2,
  NotebookPen,
  Pencil,
  Plus,
  Sparkles,
} from "lucide-react";
import { BUCKETS, LINK_ERROR_MESSAGES, projectLinkError, type Note } from "@/lib/notes";
import type { AssignmentListItem } from "@/lib/assignments/types";
import { itemTitle } from "@/lib/assignment-view";
import {
  activeIn,
  progressOf,
  projectCounts,
  projectDetail,
  projectScopeIds,
  projectTree,
  treeIds,
  type ProjectCounts,
  type ProjectNode,
} from "@/lib/projects-view";
import { itemHref, projectHref, tasksHref } from "@/lib/workspace-routes";
import { AssignmentStateBadge } from "./assignment-status";
import { DelegateDialog } from "./delegate-dialog";
import { useLocalToday } from "./due-items";
import { useAssignmentIndex } from "./use-assignment-index";
import { useAvailability } from "./use-assignment";
import { ItemRow, TaskRow, WorkEmpty, WorkHeader } from "./work-rows";
import { useWorkspaceShell } from "./workspace-shell-context";

const projectTitle = (note: Pick<Note, "title">) => note.title.trim() || "Untitled project";

/** "3 open · 2 done" and a bar for the real done/total ratio (none without items). */
function Progress({ counts }: { counts: ProjectCounts }) {
  const ratio = progressOf(counts);
  if (ratio === null) return <span className="project-counts">No items yet</span>;
  const percent = Math.round(ratio * 100);
  return (
    <span className="project-counts">
      <span>
        {counts.open} open · {counts.done} done
      </span>
      <span className="project-progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="project-percent">{percent}%</span>
    </span>
  );
}

function AgentIndicator({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="project-agent">
      <Bot size={12} aria-hidden="true" />
      {count} with the agent
    </span>
  );
}

function TreeLevel({
  nodes,
  id,
  collapsed,
  onToggle,
  activeFor,
}: {
  nodes: ProjectNode[];
  id?: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  activeFor: (projectId: string) => number;
}) {
  return (
    <ul className="project-tree" id={id}>
      {nodes.map((node) => {
        const pid = node.project.id;
        const hasChildren = node.children.length > 0;
        const open = !collapsed.has(pid);
        const childId = `project-tree-${pid}`;
        const title = projectTitle(node.project);
        return (
          <li key={pid}>
            <div
              className={`project-row ${node.project.completedAt ? "is-complete" : ""}`}
              style={{ "--depth": node.depth - 1 } as React.CSSProperties}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-expanded={open}
                  aria-controls={childId}
                  aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
                  onClick={() => onToggle(pid)}
                >
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              ) : (
                <span className="tree-spacer" aria-hidden="true" />
              )}
              <Link className="project-row-link" href={projectHref(pid)}>
                <strong>{title}</strong>
                {node.project.completedAt && <span className="task-badge">Completed</span>}
                {hasChildren && (
                  <small>
                    {node.children.length} sub-project{node.children.length === 1 ? "" : "s"}
                  </small>
                )}
              </Link>
              <Progress counts={node.counts} />
              <AgentIndicator count={activeFor(pid)} />
            </div>
            {hasChildren && open && (
              <TreeLevel nodes={node.children} id={childId} collapsed={collapsed} onToggle={onToggle} activeFor={activeFor} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Projects (`/projects`): every project in this space as an indented,
 * collapsible tree (nested lists with disclosure buttons). Counts cover the
 * items inside each project and its sub-projects; progress is done/total.
 */
export function ProjectsPage() {
  const { notes, workspaceId, loadError, assignmentsVersion, createItem } = useWorkspaceShell();
  const tree = useMemo(() => projectTree(notes, workspaceId), [notes, workspaceId]);
  const index = useAssignmentIndex(workspaceId, assignmentsVersion);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const all = treeIds(tree);
  const nested = tree.some((n) => n.children.length);
  const activeFor = (id: string) => (index.list ? activeIn(index.list, projectScopeIds(notes, id)) : 0);
  function toggle(id: string) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <main className="work-page projects-page">
      <WorkHeader
        icon={<Layers size={22} />}
        eyebrow="OUTCOMES AND RELATED WORK"
        title="Projects"
        description={tree.length ? `${all.length} project${all.length === 1 ? "" : "s"} in this space.` : "Outcomes that need more than one step."}
        actions={
          <button
            type="button"
            className="primary-button small"
            disabled={loadError}
            onClick={() => createItem({ kind: "project", bucket: "projects", projectId: null })}
          >
            <Plus size={15} aria-hidden="true" /> New project
          </button>
        }
      />
      {loadError ? (
        <p className="work-state" role="alert">Your projects couldn’t be loaded. Reload the page to try again.</p>
      ) : !tree.length ? (
        <WorkEmpty
          title="No projects yet"
          body="Create a project, or change an item’s kind to Project in the editor. Link tasks, notes and documents to it from their Project field."
        />
      ) : (
        <section className="work-section" aria-labelledby="projects-tree-heading">
          <div className="work-section-heading">
            <h2 id="projects-tree-heading">
              All projects <span className="work-count">{all.length}</span>
            </h2>
            {nested && (
              <div className="work-section-actions">
                <button type="button" className="text-button" onClick={() => setCollapsed(new Set())}>
                  Expand all
                </button>
                <button type="button" className="text-button" onClick={() => setCollapsed(new Set(all))}>
                  Collapse all
                </button>
              </div>
            )}
          </div>
          <TreeLevel nodes={tree} collapsed={collapsed} onToggle={toggle} activeFor={activeFor} />
        </section>
      )}
    </main>
  );
}

function DetailSection({
  title,
  icon,
  count,
  children,
  empty,
  extra,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  children: ReactNode;
  empty: string;
  extra?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="work-section" aria-labelledby={id}>
      <div className="work-section-heading">
        <h2 id={id}>
          <span className="work-section-icon" aria-hidden="true">
            {icon}
          </span>
          {title}
          <span className="work-count">{count}</span>
        </h2>
        {extra}
      </div>
      {count ? children : <p className="work-section-empty">{empty}</p>}
    </section>
  );
}

function AssignmentRow({ assignment, notes }: { assignment: AssignmentListItem; notes: Note[] }) {
  const { openAssignment } = useWorkspaceShell();
  const source = assignment.sourceNoteId ? notes.find((n) => n.id === assignment.sourceNoteId) : undefined;
  return (
    <li>
      <button type="button" className={`agent-row is-${assignment.state}`} aria-haspopup="dialog" onClick={() => openAssignment(assignment.id)}>
        <span className="agent-row-main">
          {/* User-written outcome; plain text. */}
          <strong className="agent-row-outcome">{assignment.requestedOutcome}</strong>
          <span className="agent-row-source">From “{itemTitle(source)}”</span>
          <span className="agent-row-meta">
            <AssignmentStateBadge state={assignment.state} />
            {assignment.savedNoteId && <small>Saved as a document</small>}
          </span>
        </span>
        <span className="agent-row-go">
          Open
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

/** How many assignments the detail lists (newest first; Agents has the rest). */
const DETAIL_ASSIGNMENTS = 20;

/**
 * Project detail (`/projects/[id]`): breadcrumb of parent projects, quick
 * actions, then sub-projects, tasks (open, then done), notes, documents
 * (including saved agent results) and assignments for the project and
 * everything inside it. Unknown or deleted ids get a friendly not-found.
 */
export function ProjectPage({ id }: { id: string }) {
  const {
    notes,
    workspaceId,
    loadError,
    assignmentsVersion,
    assignmentChanged,
    openAssignment,
    openNote,
    createItem,
    agentEnabled,
    openSettings,
    openAgentDialog,
    showToast,
  } = useWorkspaceShell();
  const detail = useMemo(() => projectDetail(notes, id), [notes, id]);
  const today = useLocalToday();
  const index = useAssignmentIndex(workspaceId, assignmentsVersion);
  const { availability } = useAvailability(workspaceId, agentEnabled);
  const [delegating, setDelegating] = useState(false);
  const scope = useMemo(() => projectScopeIds(notes, id), [notes, id]);

  if (!detail || detail.project.workspaceId !== workspaceId)
    return (
      <main className="work-page project-page">
        <WorkHeader icon={<Layers size={22} />} eyebrow="PROJECT" title="Project not found" />
        <WorkEmpty
          title={loadError ? "Your projects couldn’t be loaded" : "This project isn’t here"}
          body={
            loadError
              ? "Reload the page to try again."
              : "It may have been deleted, turned into another kind of item, or it belongs to another space."
          }
        >
          <Link className="secondary-button" href="/projects">
            Back to Projects
          </Link>
        </WorkEmpty>
      </main>
    );

  const { project, ancestors } = detail;
  const title = projectTitle(project);
  const bucket = BUCKETS.find((b) => b.id === project.bucket);
  const subprojectError = projectLinkError(notes, "__new__", project.id, "project");
  const assignmentsHere = (index.list ?? []).filter((a) => a.sourceNoteId && scope.has(a.sourceNoteId));
  const taskCount = detail.tasks.open.length + detail.tasks.done.length;
  const row = (n: Note) => <TaskRow key={n.id} note={n} today={today} assignment={index.forNote(n.id)} showProject={false} />;

  return (
    <main className="work-page project-page">
      <WorkHeader
        icon={<Layers size={22} />}
        eyebrow={`PROJECT${bucket ? ` · ${bucket.name.toUpperCase()}` : ""}`}
        title={title}
        before={
          <nav className="work-breadcrumb" aria-label="Breadcrumb">
            <ol>
              <li>
                <Link href="/projects">Projects</Link>
              </li>
              {ancestors.map((a) => (
                <li key={a.id}>
                  <Link href={projectHref(a.id)}>{projectTitle(a)}</Link>
                </li>
              ))}
              <li aria-current="page">{title}</li>
            </ol>
          </nav>
        }
        description={
          <>
            {project.completedAt ? "Completed. " : ""}
            <Progress counts={projectCounts(notes, project.id)} />
          </>
        }
        actions={
          <>
            <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => openNote(project.id)}>
              <Pencil size={14} aria-hidden="true" /> Edit
            </button>
            <Link className="secondary-button" href={itemHref(project.id)}>
              <Maximize2 size={14} aria-hidden="true" /> Full page
            </Link>
            <button
              type="button"
              className="secondary-button"
              aria-haspopup="dialog"
              disabled={!project.workspaceId}
              onClick={() => setDelegating(true)}
            >
              <Sparkles size={14} aria-hidden="true" /> Delegate
            </button>
          </>
        }
      />
      <div className="work-quick-add" role="group" aria-label="Add to this project">
        <button
          type="button"
          className="primary-button small"
          disabled={loadError}
          onClick={() => createItem({ kind: "task", bucket: "next", projectId: project.id })}
        >
          <Plus size={14} aria-hidden="true" /> Add task to this project
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={loadError}
          onClick={() => createItem({ kind: "note", bucket: "reference", projectId: project.id })}
        >
          <NotebookPen size={14} aria-hidden="true" /> Add note
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={loadError || !!subprojectError}
          title={subprojectError ? LINK_ERROR_MESSAGES[subprojectError] : undefined}
          onClick={() => {
            if (subprojectError) showToast(LINK_ERROR_MESSAGES[subprojectError]);
            else createItem({ kind: "project", bucket: "projects", projectId: project.id });
          }}
        >
          <Layers size={14} aria-hidden="true" /> Add sub-project
        </button>
      </div>

      <DetailSection
        title="Sub-projects"
        icon={<Layers size={14} />}
        count={detail.subprojects.length}
        empty="No sub-projects. Add one when part of this outcome needs its own steps."
      >
        <ul className="work-list">
          {detail.subprojects.map(({ project: sub, counts }) => (
            <li key={sub.id} className={`project-row is-flat ${sub.completedAt ? "is-complete" : ""}`}>
              <Link className="project-row-link" href={projectHref(sub.id)}>
                <strong>{projectTitle(sub)}</strong>
                {sub.completedAt && <span className="task-badge">Completed</span>}
              </Link>
              <Progress counts={counts} />
              <AgentIndicator count={index.list ? activeIn(index.list, projectScopeIds(notes, sub.id)) : 0} />
            </li>
          ))}
        </ul>
      </DetailSection>

      <DetailSection
        title="Tasks"
        icon={<ListChecks size={14} />}
        count={taskCount}
        empty="No tasks yet. Add the next step above."
        extra={
          taskCount > 0 && (
            <Link className="text-button" href={tasksHref({ project: project.id })}>
              Open in Tasks <ChevronRight size={13} aria-hidden="true" />
            </Link>
          )
        }
      >
        {detail.tasks.open.length > 0 ? (
          <ul className="work-list">{detail.tasks.open.map(row)}</ul>
        ) : (
          <p className="work-section-empty">Every task here is done.</p>
        )}
        {detail.tasks.done.length > 0 && (
          <>
            <h3 className="work-subheading">
              Done <span className="work-count">{detail.tasks.done.length}</span>
            </h3>
            <ul className="work-list">{detail.tasks.done.map(row)}</ul>
          </>
        )}
      </DetailSection>

      <DetailSection
        title="Notes"
        icon={<NotebookPen size={14} />}
        count={detail.notes.length}
        empty="No notes linked to this project."
      >
        <ul className="work-list">
          {detail.notes.map((n) => (
            <ItemRow key={n.id} note={n} />
          ))}
        </ul>
      </DetailSection>

      <DetailSection
        title="Documents"
        icon={<FileText size={14} />}
        count={detail.documents.length}
        empty="No documents yet. Agent results you save to this project appear here."
      >
        <ul className="work-list">
          {detail.documents.map((n) => (
            <ItemRow key={n.id} note={n} />
          ))}
        </ul>
      </DetailSection>

      <DetailSection
        title="Assignments"
        icon={<Bot size={14} />}
        count={assignmentsHere.length}
        empty={
          index.list
            ? "Nothing in this project has been delegated yet."
            : "Checking for delegated work…"
        }
        extra={
          <Link className="text-button" href="/agents">
            All agent work <ChevronRight size={13} aria-hidden="true" />
          </Link>
        }
      >
        <ul className="agents-list">
          {assignmentsHere.slice(0, DETAIL_ASSIGNMENTS).map((a) => (
            <AssignmentRow key={a.id} assignment={a} notes={notes} />
          ))}
        </ul>
        {assignmentsHere.length > DETAIL_ASSIGNMENTS && (
          <p className="work-section-empty">
            Showing the newest {DETAIL_ASSIGNMENTS}. The Agents page has the rest.
          </p>
        )}
      </DetailSection>

      {delegating && (
        <DelegateDialog
          note={project}
          notes={notes}
          availability={availability}
          onClose={() => setDelegating(false)}
          onCreated={(created) => {
            assignmentChanged(created);
            setDelegating(false);
            openAssignment(created.id);
          }}
          onOpenAssignment={(existing) => {
            setDelegating(false);
            openAssignment(existing);
          }}
          onOpenSettings={openSettings}
          onOpenAgent={() => {
            setDelegating(false);
            openAgentDialog();
          }}
        />
      )}
    </main>
  );
}
