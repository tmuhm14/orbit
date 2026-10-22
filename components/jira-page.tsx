"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Flag, LoaderCircle, RefreshCw, SquareKanban } from "lucide-react";
import {
  JIRA_WINDOWS, UNASSIGNED, activityPeople, groupMine, initials, isUrgent, jiraUrl, relativeTime, splitActivity, upcomingGroups,
  type JiraDashboard, type JiraIssue, type JiraSection,
} from "@/lib/jira/view";
import { settingsHref } from "@/lib/settings-sections";
import { jiraHref, parseJiraParams } from "@/lib/workspace-routes";
import { dueDateLabel, useLocalToday } from "./due-items";
import { WorkEmpty, WorkHeader } from "./work-rows";

const REFRESH_MS = 5 * 60_000;

const typeTone = (type: string) =>
  /bug/i.test(type) ? "bug" : /story/i.test(type) ? "story" : /epic/i.test(type) ? "epic" : /sub/i.test(type) ? "subtask" : "task";

function IssueRow({ issue, today, now, showAssignee = false, showSprint = true }: {
  issue: JiraIssue;
  today: string;
  now: number;
  showAssignee?: boolean;
  showSprint?: boolean;
}) {
  const href = jiraUrl(issue.url);
  const title = <><span className="jira-key">{issue.key}</span><span className="jira-summary">{issue.summary}</span></>;
  // Finished work reads by when it was resolved; everything else by its last touch.
  const when = issue.category === "done" && issue.resolved ? issue.resolved : issue.updated;
  return (
    <li className={`jira-issue tone-${typeTone(issue.type)}`}>
      <span className="jira-type" title={issue.type} aria-label={issue.type} />
      <div className="jira-issue-body">
        {href
          ? <a className="jira-issue-title" href={href} target="_blank" rel="noopener noreferrer">{title}</a>
          : <span className="jira-issue-title">{title}</span>}
        <div className="jira-issue-meta">
          <span className={`jira-status is-${issue.category}`}>{issue.status}</span>
          {isUrgent(issue) && <span className="jira-priority"><Flag size={11} /> {issue.priority}</span>}
          {issue.due && (
            <span className={`jira-due ${issue.category !== "done" && issue.due < today ? "is-late" : ""}`}>
              Due {dueDateLabel(issue.due, today)}
            </span>
          )}
          {issue.epic && <span className="jira-epic" title={`${issue.epic.key} · ${issue.epic.summary}`}>{issue.epic.summary}</span>}
          {showSprint && issue.sprint && <span className="jira-sprint">{issue.sprint.name}</span>}
        </div>
      </div>
      <div className="jira-issue-side">
        {showAssignee && (
          <span className={`jira-avatar ${issue.assignedToMe ? "is-me" : ""}`} title={issue.assignee ?? "Unassigned"}>
            {initials(issue.assignee)}
          </span>
        )}
        <time dateTime={when} title={new Date(when).toLocaleString()}>{relativeTime(when, now)}</time>
      </div>
    </li>
  );
}

function IssueList({ issues, empty, limit = 8, ...row }: {
  issues: JiraIssue[];
  empty: string;
  limit?: number;
  today: string;
  now: number;
  showAssignee?: boolean;
  showSprint?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!issues.length) return <p className="jira-empty">{empty}</p>;
  return (
    <>
      <ul className="jira-issues">
        {(open ? issues : issues.slice(0, limit)).map((issue) => <IssueRow key={issue.key} issue={issue} {...row} />)}
      </ul>
      {issues.length > limit && (
        <button type="button" className="text-button jira-more" onClick={() => setOpen((value) => !value)}>
          {open ? "Show fewer" : `Show ${issues.length - limit} more`}
        </button>
      )}
    </>
  );
}

function Panel({ id, title, count, link, actions, className = "", children }: {
  id: string;
  title: string;
  count?: string | number;
  link?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const href = link ? jiraUrl(link) : undefined;
  return (
    <section className={`jira-panel ${className}`} aria-labelledby={id}>
      <div className="jira-panel-heading">
        <h2 id={id}>{title}{count !== undefined && <small>{count}</small>}</h2>
        <div className="jira-panel-actions">
          {actions}
          {href && (
            <a className="jira-open" href={href} target="_blank" rel="noopener noreferrer">
              Open in Jira <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

const failed = (dashboard: JiraDashboard, section: JiraSection) => dashboard.errors.find((e) => e.section === section);

function SectionError({ dashboard, section }: { dashboard: JiraDashboard; section: JiraSection }) {
  const error = failed(dashboard, section);
  return error ? <p className="jira-error" role="alert">{error.message}</p> : null;
}

const plus = (count: number, truncated: boolean) => `${count}${truncated ? "+" : ""}`;
const projectList = (projects: string[]) =>
  projects.length < 2 ? projects.join("") : `${projects.slice(0, -1).join(", ")} and ${projects.at(-1)}`;

/**
 * Jira (`/jira`): issues assigned to you, what the team's projects moved in
 * the last `?days=` (7, 14 or 30), optionally for one `?person=`, and what is
 * coming up. Read live from Jira with the connection saved in Settings, and
 * refreshed every five minutes while the tab is visible.
 */
export function JiraPage() {
  const { days, person } = parseJiraParams(useSearchParams());
  const today = useLocalToday();
  const [dashboard, setDashboard] = useState<JiraDashboard | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);

  async function refresh() {
    const id = ++request.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/jira/dashboard?days=${days}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (id !== request.current) return;
      setNotConnected(response.status === 409 && data.code === "not_connected");
      if (response.ok) {
        setDashboard(data.dashboard);
        setError("");
      } else setError(data.error || "Jira couldn’t be loaded");
    } catch {
      if (id === request.current) setError("Jira couldn’t be loaded. Check your connection and try again.");
    } finally {
      if (id === request.current) {
        setBusy(false);
        setNow(Date.now());
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [days]);

  const mine = useMemo(() => groupMine(dashboard?.mine ?? []), [dashboard]);
  const upcoming = useMemo(() => (today ? upcomingGroups(dashboard?.upcoming ?? [], today) : []), [dashboard, today]);
  const people = useMemo(() => activityPeople(dashboard?.activity ?? []), [dashboard]);
  const activity = useMemo(() => splitActivity(dashboard?.activity ?? [], person), [dashboard, person]);
  const allCompleted = useMemo(() => splitActivity(dashboard?.activity ?? [], null).completed.length, [dashboard]);
  const upcomingCount = upcoming.reduce((total, group) => total + group.issues.length, 0);

  const header = (
    <WorkHeader
      eyebrow="YOUR TEAM IN JIRA"
      title="Jira"
      icon={<SquareKanban size={24} />}
      description={dashboard?.projects.length
        ? `What’s assigned to you, what ${projectList(dashboard.projects)} moved lately, and what’s coming up.`
        : "What’s assigned to you, what your team moved lately, and what’s coming up."}
      actions={!notConnected && (
        <button type="button" className="secondary-button jira-refresh" onClick={() => void refresh()} disabled={busy}>
          {busy ? <LoaderCircle className="jira-spin" size={15} /> : <RefreshCw size={15} />}
          {dashboard ? `Updated ${relativeTime(dashboard.generatedAt, now)}` : "Refresh"}
        </button>
      )}
    />
  );

  if (notConnected)
    return (
      <main className="work-page jira-page">
        {header}
        <WorkEmpty
          title="Connect Jira to see your dashboard"
          body="Add your Jira Cloud site, account email and an API token. Orbit reads issues live to build this page and doesn’t store them."
        >
          <Link className="secondary-button" href={settingsHref("integrations")}>Open Integrations <ArrowUpRight size={14} /></Link>
        </WorkEmpty>
      </main>
    );

  if (!dashboard || !today)
    return (
      <main className="work-page jira-page">
        {header}
        {error
          ? <p className="jira-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void refresh()}>Try again</button></p>
          : <p className="work-state jira-loading"><LoaderCircle className="jira-spin" size={15} /> Reading Jira…</p>}
      </main>
    );

  const noTeam = !dashboard.projects.length && !failed(dashboard, "mine");
  const teamHint = "No team projects yet. Orbit uses the projects of your open Jira assignments, plus project keys on your scheduled debriefs.";
  const row = { today, now };
  return (
    <main className="work-page jira-page">
      {header}
      {error && <p className="jira-error" role="alert">{error} Showing the last update.</p>}

      <div className="jira-stats">
        <div><strong>{plus(dashboard.mine.length, dashboard.truncated.mine)}</strong><span>Assigned to you</span></div>
        <div><strong>{mine.doing.length}</strong><span>You have in progress</span></div>
        <div><strong>{plus(dashboard.activity.length, dashboard.truncated.activity)}</strong><span>Team moved in {days} days</span></div>
        <div><strong>{allCompleted}</strong><span>Team completed</span></div>
        <div><strong>{plus(upcomingCount, dashboard.truncated.upcoming)}</strong><span>Coming up</span></div>
      </div>

      <div className="jira-grid">
        <Panel id="jira-mine" title="Assigned to you" count={dashboard.mine.length} link={dashboard.links.mine}>
          <SectionError dashboard={dashboard} section="mine" />
          {!failed(dashboard, "mine") && (
            <>
              <h3 className="jira-group">In progress <small>{mine.doing.length}</small></h3>
              <IssueList issues={mine.doing} empty="Nothing in progress." {...row} />
              <h3 className="jira-group">To do <small>{mine.todo.length}</small></h3>
              <IssueList issues={mine.todo} empty="Nothing waiting on you." {...row} />
            </>
          )}
        </Panel>

        <Panel id="jira-upcoming" title="Coming up" count={upcomingCount || undefined} link={dashboard.links.upcoming || undefined}>
          <SectionError dashboard={dashboard} section="upcoming" />
          {noTeam ? <p className="jira-empty">{teamHint}</p> : upcoming.length ? upcoming.map((group) => (
            <div className="jira-upcoming-group" key={group.id}>
              <h3 className={`jira-group ${group.id === "overdue" ? "is-late" : ""}`}>
                {group.label} <small>{group.issues.length}</small>
                {group.detail && <span className="jira-group-detail">{group.detail}</span>}
              </h3>
              <IssueList issues={group.issues} empty="" limit={5} showAssignee showSprint={!group.id.includes(":")} {...row} />
            </div>
          )) : !failed(dashboard, "upcoming") && (
            <p className="jira-empty">Nothing due, queued or planned in a sprint.</p>
          )}
        </Panel>
      </div>

      <Panel
        id="jira-activity"
        className="jira-activity"
        title="Team activity"
        count={plus(dashboard.activity.length, dashboard.truncated.activity)}
        link={dashboard.links.activity || undefined}
        actions={(
          <nav className="jira-windows" aria-label="Activity window">
            {JIRA_WINDOWS.map((value) => (
              <Link key={value} href={jiraHref({ days: value, person })} scroll={false}
                className={value === days ? "active" : ""} aria-current={value === days ? "page" : undefined}>
                {value}d
              </Link>
            ))}
          </nav>
        )}
      >
        <SectionError dashboard={dashboard} section="activity" />
        {noTeam ? <p className="jira-empty">{teamHint}</p> : !failed(dashboard, "activity") && (
          <>
            {people.length > 0 && (
              <nav className="jira-people" aria-label="Filter by person">
                <Link href={jiraHref({ days })} scroll={false} className={!person ? "active" : ""} aria-current={!person ? "page" : undefined}>
                  Everyone <small>{dashboard.activity.length}</small>
                </Link>
                {people.map((p) => (
                  <Link key={p.name} href={jiraHref({ days, person: p.name })} scroll={false}
                    className={`${person === p.name ? "active" : ""} ${p.me ? "is-me" : ""}`}
                    aria-current={person === p.name ? "page" : undefined}
                    title={`${p.name}: ${p.total} moved, ${p.completed} completed`}>
                    <span className="jira-avatar">{initials(p.name === UNASSIGNED ? null : p.name)}</span>
                    {p.me ? "You" : p.name.split(" ")[0]} <small>{p.total}</small>
                  </Link>
                ))}
              </nav>
            )}
            {person && !people.some((p) => p.name === person) && (
              <p className="jira-empty">
                No activity for {person} in the last {days} days. <Link href={jiraHref({ days })} scroll={false}>Show everyone</Link>
              </p>
            )}
            <div className="jira-activity-columns">
              <div>
                <h3 className="jira-group">Completed <small>{activity.completed.length}</small></h3>
                <IssueList issues={activity.completed} empty={`Nothing completed in the last ${days} days.`} limit={10} showAssignee {...row} />
              </div>
              <div>
                <h3 className="jira-group">In motion <small>{activity.moving.length}</small></h3>
                <IssueList issues={activity.moving} empty="Nothing else moved." limit={10} showAssignee {...row} />
              </div>
            </div>
            {dashboard.truncated.activity && (
              <p className="jira-hint">Showing the {dashboard.activity.length} most recently updated. Open in Jira for the rest.</p>
            )}
          </>
        )}
      </Panel>
    </main>
  );
}
