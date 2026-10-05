import { requireAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { authConfig, siteUrl } from "@/lib/supabase/config";
import { AdminScreen, type AdminData } from "@/components/admin-screen";

export const metadata = { title: "Administration — Orbit" };

type Row = { user_id: string; source: string; triage_status: string };

export default async function Admin() {
  const me = await requireAdmin();
  const admin = createAdminClient();
  const config = authConfig();
  const env = (name: string) => !!process.env[name];
  const missingResend = [
    "RESEND_API_KEY",
    "RESEND_WEBHOOK_SECRET",
    "RESEND_INBOUND_DOMAIN",
  ].filter((name) => !env(name));
  const checks: AdminData["checks"] = [
    {
      name: "Supabase",
      ok: !!config,
      detail: config
        ? new URL(config.url).host
        : "NEXT_PUBLIC_SUPABASE_URL / key missing",
    },
    {
      name: "Supabase secret key",
      ok: !!admin,
      detail: admin
        ? "Set (server only)"
        : "SUPABASE_SECRET_KEY missing; Slack, email, and this page need it",
    },
    {
      name: "Slack",
      ok: env("SLACK_SIGNING_SECRET"),
      detail: env("SLACK_SIGNING_SECRET")
        ? "Signing secret set"
        : "SLACK_SIGNING_SECRET missing",
    },
    {
      name: "Email (Resend)",
      ok: !missingResend.length,
      detail: missingResend.length
        ? `${missingResend.join(", ")} missing`
        : `Receiving at ${process.env.RESEND_INBOUND_DOMAIN}`,
    },
    {
      name: "Account email",
      ok: process.env.AUTH_EMAIL_ENABLED === "true",
      warn: true,
      detail:
        process.env.AUTH_EMAIL_ENABLED === "true"
          ? "Sign-up and password reset emails are on"
          : "Off: sign-up and reset emails are paused; create accounts here",
    },
  ];
  const integrations = {
    slackUrl: `${siteUrl()}/api/slack/interact`,
    emailUrl: `${siteUrl()}/api/email/inbound`,
    inboundDomain: process.env.RESEND_INBOUND_DOMAIN || null,
  };
  if (!admin)
    return (
      <AdminScreen
        data={{
          me: me.id,
          checks,
          integrations,
          users: [],
          events: [],
          databaseError: "Secret key missing",
        }}
      />
    );

  const [
    usersResult,
    notesResult,
    workspacesResult,
    linksResult,
    eventsResult,
  ] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("notes").select("user_id,source,triage_status").returns<Row[]>(),
    admin.from("workspaces").select("id,name,user_id"),
    admin.from("slack_links").select("user_id,slack_team_name"),
    admin
      .from("integration_events")
      .select("id,source,status,detail,user_id,workspace_id,created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const databaseError =
    [
      usersResult.error,
      notesResult.error,
      workspacesResult.error,
      linksResult.error,
      eventsResult.error,
    ]
      .filter(Boolean)
      .map((e) => e!.message)
      .join("; ") || null;
  const notes = notesResult.data ?? [];
  const workspaces = workspacesResult.data ?? [];
  const links = linksResult.data ?? [];
  const users: AdminData["users"] = (usersResult.data?.users ?? []).map((u) => {
    const mine = notes.filter((n) => n.user_id === u.id);
    return {
      id: u.id,
      email: u.email || "(no email)",
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at ?? null,
      disabled: !!u.banned_until && new Date(u.banned_until) > new Date(),
      isAdmin: u.id === me.id,
      notes: mine.length,
      pending: mine.filter((n) => n.triage_status === "pending").length,
      bySource: {
        web: mine.filter((n) => n.source === "web").length,
        slack: mine.filter((n) => n.source === "slack").length,
        email: mine.filter((n) => n.source === "email").length,
      },
      workspaces: workspaces
        .filter((w) => w.user_id === u.id)
        .map((w) => w.name),
      slack: links
        .filter((l) => l.user_id === u.id)
        .map((l) => l.slack_team_name || "Slack"),
    };
  });
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  const workspaceById = new Map(workspaces.map((w) => [w.id, w.name]));
  const events: AdminData["events"] = (eventsResult.data ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    status: e.status,
    detail: e.detail,
    user: e.user_id ? (emailById.get(e.user_id) ?? null) : null,
    workspace: e.workspace_id
      ? (workspaceById.get(e.workspace_id) ?? null)
      : null,
    createdAt: e.created_at,
  }));
  return (
    <AdminScreen
      data={{ me: me.id, checks, integrations, users, events, databaseError }}
    />
  );
}
