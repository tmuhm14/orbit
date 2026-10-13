"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, Download, Plus, RefreshCw } from "lucide-react";
import type { DebriefReport } from "@/lib/scheduled/debrief";
import type { TaskInput } from "@/lib/scheduled/validation";
import { sendScheduled } from "@/lib/scheduled/client";

type Task = TaskInput & { id: string; created_at: string };
type Run = {
  id: string;
  task_id: string;
  report_date: string;
  trigger: "scheduled" | "manual";
  status: "running" | "done" | "partial" | "failed";
  report: DebriefReport | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  : "—";

function sourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname.endsWith(".atlassian.net"))
      ? url.href : undefined;
  } catch { return undefined; }
}

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = sourceUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}

function AuditDetail({ run, task }: { run: Run; task?: Task }) {
  const report = run.report;
  const duration = run.finished_at
    ? Math.max(0, Math.round((Date.parse(run.finished_at) - Date.parse(run.created_at)) / 1000))
    : null;
  const audit = run;
  function download() {
    const blob = new Blob([JSON.stringify(audit, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orbit-job-audit-${run.report_date}-${run.id}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return <section className="audit-detail" aria-labelledby="audit-detail-title">
    <div className="audit-detail-heading"><div><div className="eyebrow">RUN AUDIT</div><h2 id="audit-detail-title">{task?.name ?? "Deleted job"}</h2><p>Report date {run.report_date}</p></div><button className="secondary-button" onClick={download}><Download size={15} /> Download JSON</button></div>
    <div className="audit-facts">
      <div><span>Status</span><strong className={`audit-status audit-${run.status}`}>{run.status}</strong></div>
      <div><span>Started</span><strong>{dateTime(run.created_at)}</strong></div>
      <div><span>Finished</span><strong>{dateTime(run.finished_at)}</strong></div>
      <div><span>Duration</span><strong>{duration === null ? "In progress" : `${duration}s`}</strong></div>
      <div><span>Trigger</span><strong>{run.trigger === "manual" ? "Run now" : "Schedule"}</strong></div>
      <div><span>Run ID</span><code>{run.id}</code></div>
    </div>
    {run.error && <p className="scheduled-error" role="alert">{run.error}</p>}
    {run.status === "running" && <p className="audit-notice">This job is running. The audit updates automatically.</p>}
    {report && <>
      <div className="audit-totals"><span>{report.jira.issues.length} Jira issues</span><span>{report.github.prs.length} pull requests</span><span>{report.github.commits.length} commits</span></div>
      <section className="audit-source"><h3>Jira issues <small>{report.jira.issues.length}</small></h3>
        {report.jira.error && <p className="scheduled-error">{report.jira.error}</p>}
        {report.jira.issues.length ? <ul>{report.jira.issues.map((issue) => <li key={issue.key}><SourceLink href={issue.url}>{issue.key}</SourceLink><span>{issue.type}</span><span>{issue.status}</span></li>)}</ul> : <p className="agent-muted">No Jira issues in this report.</p>}
        {report.jira.truncated && <p className="scheduled-hint">Jira results reached the collection limit.</p>}
      </section>
      <section className="audit-source"><h3>GitHub pull requests <small>{report.github.prs.length}</small></h3>
        {report.github.prs.length ? <ul>{report.github.prs.map((pr) => <li key={`${pr.repo}/${pr.number}`}><SourceLink href={pr.url}>{pr.repo} #{pr.number}</SourceLink><span>{pr.author}</span><span>{pr.state}</span></li>)}</ul> : <p className="agent-muted">No pull requests in this report.</p>}
      </section>
      <section className="audit-source"><h3>GitHub commits <small>{report.github.commits.length}</small></h3>
        {report.github.commits.length ? <ul>{report.github.commits.map((commit) => <li key={`${commit.repo}/${commit.sha}`}><SourceLink href={commit.url}>{commit.repo} {commit.sha}</SourceLink><span>{commit.author}</span></li>)}</ul> : <p className="agent-muted">No commits in this report.</p>}
        {report.github.errors.map((error) => <p className="scheduled-error" key={error}>{error}</p>)}
        {report.github.truncated && <p className="scheduled-hint">GitHub results reached the collection limit.</p>}
      </section>
      <details className="audit-json"><summary>Saved audit data</summary><pre>{JSON.stringify(audit, null, 2)}</pre></details>
    </>}
    {run.status !== "running" && !report && <p className="agent-muted">No report was saved for this run.</p>}
  </section>;
}

export function ScheduledAudit({ onOpenScheduled, refreshToken }: {
  onOpenScheduled: () => void;
  refreshToken: number;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadedOlder = useRef(false);

  async function refresh() {
    try {
      const data = await sendScheduled("/api/scheduled-tasks/audit");
      const first = data.runs as Run[];
      setTasks(data.tasks ?? []);
      setRuns((previous) => {
        const ids = new Set(first.map((run) => run.id));
        return [...first, ...previous.filter((run) => !ids.has(run.id))];
      });
      if (!loadedOlder.current) setHasMore(data.hasMore);
      setSelectedId((current) => current ?? first[0]?.id ?? null);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load job history");
    } finally { setLoaded(true); }
  }

  useEffect(() => {
    loadedOlder.current = false;
    setRuns([]);
    setSelectedId(null);
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshToken]);

  async function loadMore() {
    setBusy(true); setError("");
    try {
      const oldest = runs.at(-1);
      if (!oldest) return;
      const data = await sendScheduled(`/api/scheduled-tasks/audit?before=${encodeURIComponent(oldest.created_at)}`);
      setRuns((previous) => {
        const ids = new Set(previous.map((run) => run.id));
        return [...previous, ...(data.runs as Run[]).filter((run) => !ids.has(run.id))];
      });
      loadedOlder.current = true;
      setHasMore(data.hasMore);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load older runs");
    } finally { setBusy(false); }
  }

  const shown = runs.filter((run) =>
    (jobFilter === "all" || run.task_id === jobFilter) &&
    (statusFilter === "all" || run.status === statusFilter));
  const selected = shown.find((run) => run.id === selectedId) ?? shown[0];
  const active = tasks.filter((task) => task.enabled).length;
  const running = runs.filter((run) => run.status === "running").length;
  return <main className="scheduled-page">
    <header className="scheduled-page-header"><div><div className="eyebrow">AUTOMATED WORK</div><h1>Scheduled jobs</h1><p>See what is configured, what is running, and the full saved output of each run.</p></div><button className="primary-button" onClick={onOpenScheduled}><Plus size={16} /> Set up a job</button></header>
    <div className="scheduled-page-stats"><div><strong>{tasks.length}</strong><span>Jobs</span></div><div><strong>{active}</strong><span>On</span></div><div><strong>{running}</strong><span>Running</span></div><div><strong>{runs.length}{hasMore ? "+" : ""}</strong><span>Runs</span></div></div>
    {error && <p className="scheduled-error" role="alert">{error} <button className="text-button" onClick={() => void refresh()}>Try again</button></p>}
    {!loaded ? <p className="agent-muted">Loading job history…</p> : <>
      <section className="scheduled-page-jobs"><div className="scheduled-page-section-heading"><h2>Jobs</h2><button className="text-button" onClick={onOpenScheduled}>Manage jobs</button></div>
        {tasks.length ? <div className="scheduled-page-job-grid">{tasks.map((task) => <div className="scheduled-page-job" key={task.id}><div><strong>{task.name}</strong><span className={`audit-status ${task.enabled ? "audit-done" : "audit-off"}`}>{task.enabled ? "On" : "Off"}</span></div><p>{task.cadence === "daily" ? "Every day" : "Weekdays"} · by {new Date(Date.UTC(2020, 0, 1, task.delivery_hour)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" })} {task.timezone.replace("America/", "")}</p><p>{task.jira_projects.length} Jira projects · {task.github_repos.length} GitHub repos</p></div>)}</div> : <p className="agent-muted">No scheduled jobs yet.</p>}
      </section>
      <section className="scheduled-page-history"><div className="scheduled-page-section-heading"><h2>Run history</h2><button className="text-button" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button></div>
        <div className="audit-filters"><label>Job<select value={jobFilter} onChange={(event) => setJobFilter(event.target.value)}><option value="all">All jobs</option>{tasks.map((task) => <option value={task.id} key={task.id}>{task.name}</option>)}</select></label><label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="done">Done</option><option value="partial">Partial</option><option value="failed">Failed</option></select></label></div>
        <div className="audit-layout"><div className="audit-run-list">{shown.length ? shown.map((run) => <button key={run.id} className={`audit-run ${selected?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedId(run.id)} aria-current={selected?.id === run.id ? "true" : undefined}><span><strong>{tasks.find((task) => task.id === run.task_id)?.name ?? "Deleted job"}</strong><small>{dateTime(run.created_at)}</small></span><span className={`audit-status audit-${run.status}`}>{run.status}</span><small>{run.report_date} · {run.trigger}</small></button>) : <p className="agent-muted">{runs.length ? "No runs match these filters." : "Runs will appear here after a job starts."}</p>}{hasMore && <button className="secondary-button audit-more" disabled={busy} onClick={() => void loadMore()}>{busy ? "Loading…" : "Load older runs"}</button>}</div>
          {selected ? <AuditDetail run={selected} task={tasks.find((task) => task.id === selected.task_id)} /> : <div className="audit-detail audit-empty"><CalendarClock size={25} /><p>Select a run to see its audit.</p></div>}
        </div>
      </section>
    </>}
  </main>;
}
