"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CalendarClock, Plus, Settings2, X } from "lucide-react";
import type { DebriefReport } from "@/lib/scheduled/debrief";
import type { TaskInput } from "@/lib/scheduled/validation";
import { sendScheduled, type ScheduledConnection } from "@/lib/scheduled/client";

type Task = TaskInput & { id: string; created_at: string };
type Run = {
  id: string;
  task_id: string;
  report_date: string;
  status: "running" | "done" | "partial" | "failed";
  trigger: "scheduled" | "manual";
  report: DebriefReport | null;
  error: string | null;
  created_at: string;
};
const starter: TaskInput = {
  name: "Nightly team debrief",
  kind: "team_debrief",
  enabled: false,
  timezone: "America/Chicago",
  delivery_hour: 6,
  cadence: "daily",
  jira_projects: ["Specialty", "Patient Management"],
  github_repos: [],
};

const lines = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

function TaskEditor({ task, connection, onRefresh, onDone, onOpenSettings, onToast }: {
  task: Task | null;
  connection: ScheduledConnection;
  onRefresh: () => Promise<void>;
  onDone: () => void;
  onOpenSettings: () => void;
  onToast: (message: string) => void;
}) {
  const [name, setName] = useState(task?.name ?? starter.name);
  const [projects, setProjects] = useState((task?.jira_projects ?? starter.jira_projects).join("\n"));
  const [repos, setRepos] = useState((task?.github_repos ?? []).join("\n"));
  const [hour, setHour] = useState(task?.delivery_hour ?? 6);
  const [timezone, setTimezone] = useState(task?.timezone ?? "America/Chicago");
  const [cadence, setCadence] = useState(task?.cadence ?? "daily");
  const [enabled, setEnabled] = useState(task?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEnable = (!lines(projects).length || connection.jiraConnected) &&
    (!lines(repos).length || connection.githubConnected) &&
    !!(lines(projects).length || lines(repos).length);
  const baseline = task ?? starter;
  const unsaved = (
    name.trim() !== baseline.name ||
    JSON.stringify(lines(projects)) !== JSON.stringify(baseline.jira_projects) ||
    JSON.stringify(lines(repos)) !== JSON.stringify(baseline.github_repos) ||
    hour !== baseline.delivery_hour || timezone !== baseline.timezone ||
    cadence !== baseline.cadence || enabled !== baseline.enabled
  );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    const body: TaskInput = {
      name: name.trim(), kind: "team_debrief", enabled, timezone,
      delivery_hour: hour, cadence,
      jira_projects: lines(projects), github_repos: lines(repos),
    };
    try {
      await sendScheduled(task ? `/api/scheduled-tasks/${task.id}` : "/api/scheduled-tasks",
        task ? "PATCH" : "POST", body);
      await onRefresh();
      onDone();
      onToast("Scheduled task saved");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save task");
    } finally { setBusy(false); }
  }
  async function runNow() {
    if (!task) return;
    setBusy(true); setError("");
    try {
      const result = await sendScheduled(`/api/scheduled-tasks/${task.id}/run`, "POST", {});
      await onRefresh();
      onToast(result.run?.status === "done" ? "Debrief ready" : "Debrief finished with source errors");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't run debrief");
      await onRefresh();
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!task || !confirm(`Remove “${task.name}” and its reports?`)) return;
    setBusy(true); setError("");
    try {
      await sendScheduled(`/api/scheduled-tasks/${task.id}`, "DELETE");
      await onRefresh();
      onDone();
      onToast("Scheduled task removed");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't remove task");
      setBusy(false);
    }
  }
  return (
    <form className="scheduled-task-card" onSubmit={save}>
      <div className="scheduled-card-heading">
        <strong>{task ? task.name : "New team debrief"}</strong>
        <span>{task?.enabled ? "On" : "Off"}</span>
      </div>
      <div className="scheduled-fields">
        <label>Name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Available by
          <select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
            {Array.from({ length: 21 }, (_, index) => index + 3).map((value) => (
              <option key={value} value={value}>{new Date(Date.UTC(2020, 0, 1, value)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" })}</option>
            ))}
          </select>
        </label>
        <label>Days
          <select value={cadence} onChange={(event) => setCadence(event.target.value as "daily" | "weekdays")}>
            <option value="daily">Every day</option><option value="weekdays">Weekdays</option>
          </select>
        </label>
        <label>Time zone
          <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            <option value="America/Chicago">Central</option>
            <option value="America/New_York">Eastern</option>
            <option value="America/Denver">Mountain</option>
            <option value="America/Los_Angeles">Pacific</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
        <label>Jira projects (name or key, one per line)
          <textarea rows={2} value={projects} onChange={(event) => setProjects(event.target.value)} placeholder="Specialty&#10;Patient Management" />
        </label>
        <label>GitHub repositories (owner/repo, one per line)
          <textarea rows={2} value={repos} onChange={(event) => setRepos(event.target.value)} placeholder="waltzhealth/patient-management" />
        </label>
      </div>
      <label className="scheduled-enable">
        <input type="checkbox" checked={enabled} disabled={!canEnable} onChange={(event) => setEnabled(event.target.checked)} />
        Run automatically
      </label>
      {!canEnable && <p className="scheduled-hint">Connect each selected source before turning this on. <button className="text-button" type="button" onClick={() => { if (!unsaved || confirm("Leave this job without saving your changes?")) onOpenSettings(); }}>Open connection settings</button></p>}
      <p className="scheduled-hint">Reports cover the previous calendar day and are prepared ahead of the chosen time.</p>
      {task && unsaved && <p className="scheduled-hint">Save these changes before running a debrief.</p>}
      {error && <p className="scheduled-error" role="alert">{error}</p>}
      <div className="scheduled-actions">
        <button className="secondary-button" type="submit" disabled={busy}>Save task</button>
        {task && <button className="text-button" type="button" disabled={busy || unsaved} onClick={runNow}>Run now</button>}
        {task && <button className="text-button scheduled-remove" type="button" disabled={busy} onClick={remove}>Remove</button>}
      </div>
    </form>
  );
}

function Report({ run, taskName }: { run: Run; taskName: string }) {
  const report = run.report;
  const done = report?.jira.issues.filter((issue) => /done|closed|complete/i.test(issue.status)).length ?? 0;
  const merged = report?.github.prs.filter((pr) => pr.state === "merged").length ?? 0;
  return (
    <details className="scheduled-report">
      <summary><strong>{taskName}</strong><span>{run.report_date} · {run.status}</span></summary>
      {run.error && <p className="scheduled-error">{run.error}</p>}
      {report && <div className="scheduled-report-body">
        <p>{report.jira.issues.length} Jira issues updated ({done} currently done) · {report.github.prs.length} PRs active ({merged} merged) · {report.github.commits.length} default branch commits</p>
        {report.jira.error && <p className="scheduled-error">{report.jira.error}</p>}
        {report.github.errors.map((error) => <p className="scheduled-error" key={error}>{error}</p>)}
        {report.jira.issues.length > 0 && <section><h4>Jira activity</h4><ul>{report.jira.issues.map((issue) => (
          <li key={issue.key}><a href={issue.url} target="_blank" rel="noopener noreferrer">{issue.key}</a><span>{issue.type} · {issue.status}</span></li>
        ))}</ul></section>}
        {report.github.prs.length > 0 && <section><h4>Pull requests</h4><ul>{report.github.prs.map((pr) => (
          <li key={`${pr.repo}/${pr.number}`}><a href={pr.url} target="_blank" rel="noopener noreferrer">{pr.repo} #{pr.number}</a><span>{pr.state} · {pr.author}</span></li>
        ))}</ul></section>}
        {report.github.commits.length > 0 && <section><h4>Default branch commits</h4><ul>{report.github.commits.map((commit) => (
          <li key={`${commit.repo}/${commit.sha}`}><a href={commit.url} target="_blank" rel="noopener noreferrer">{commit.repo} {commit.sha}</a><span>{commit.author}</span></li>
        ))}</ul></section>}
        {(report.jira.truncated || report.github.truncated) && <p className="scheduled-hint">Activity exceeded the report limit; open the linked sources for more.</p>}
      </div>}
    </details>
  );
}

export function ScheduledDialog({ onClose, onOpenSettings, onToast }: {
  onClose: () => void;
  onOpenSettings: () => void;
  onToast: (message: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [connection, setConnection] = useState<ScheduledConnection | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");
  async function refresh() {
    const data = await sendScheduled("/api/scheduled-tasks");
    setTasks(data.tasks ?? []);
    setRuns(data.runs ?? []);
    setConnection(data.connection);
  }
  useEffect(() => {
    void refresh().catch((failure) => setError(failure instanceof Error ? failure.message : "Could not load schedules"));
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);
  const editedTask = editing === "new" ? null : tasks.find((task) => task.id === editing) ?? null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="guide-dialog scheduled-dialog" role="dialog" aria-modal="true" aria-labelledby="scheduled-title">
        <button autoFocus className="icon-button guide-close" aria-label="Close scheduled work" onClick={onClose}><X size={21} /></button>
        <CalendarClock className="purple" size={29} />
        <div className="eyebrow">WORK THAT KEEPS RUNNING</div>
        <h2 id="scheduled-title">{editing ? editing === "new" ? "New debrief" : "Edit debrief" : "Scheduled work"}</h2>
        <p>{editing ? "Choose the sources and schedule for this job." : "Review your recurring jobs and their recent reports."}</p>
        {error && <p className="scheduled-error" role="alert">{error}</p>}
        {!connection ? !error && <p className="agent-muted">Loading…</p> : <>
          {editing ? <>
            <button className="text-button scheduled-back" onClick={() => setEditing(null)}><ArrowLeft size={15} /> All jobs</button>
            <TaskEditor key={editing} task={editedTask} connection={connection} onRefresh={refresh} onDone={() => setEditing(null)} onOpenSettings={onOpenSettings} onToast={onToast} />
          </> : <>
            <section className="agent-section scheduled-source-status">
              <div><h3>Connections</h3><p className="agent-muted">Jira {connection.jiraConnected ? "connected" : "not connected"} · GitHub {connection.githubConnected ? "connected" : "not connected"}</p></div>
              <button className="text-button" onClick={onOpenSettings}><Settings2 size={15} /> Connection settings</button>
            </section>
            <section className="agent-section"><div className="scheduled-section-heading"><h3>Jobs</h3><button className="text-button" onClick={() => setEditing("new")}><Plus size={14} /> Add debrief</button></div>
              {tasks.length ? <div className="scheduled-task-list">{tasks.map((task) => (
                <div className="scheduled-task-summary" key={task.id}>
                  <div><strong>{task.name}</strong><p>{task.enabled ? "On" : "Off"} · {task.cadence === "daily" ? "Every day" : "Weekdays"} · {new Date(Date.UTC(2020, 0, 1, task.delivery_hour)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" })} {task.timezone.replace("America/", "")}</p><p>{task.jira_projects.length} Jira projects · {task.github_repos.length} GitHub repositories</p></div>
                  <button className="secondary-button" onClick={() => setEditing(task.id)}>Edit job</button>
                </div>
              ))}</div> : <p className="agent-muted">No jobs yet. Add a debrief to get started.</p>}
            </section>
            <section className="agent-section"><h3>Recent reports</h3>
              {runs.length ? <div className="scheduled-reports">{runs.map((run) => <Report key={run.id} run={run} taskName={tasks.find((task) => task.id === run.task_id)?.name ?? "Team debrief"} />)}</div>
                : <p className="agent-muted">Reports will appear here after the first run.</p>}
            </section>
          </>}
        </>}
      </div>
    </div>
  );
}
