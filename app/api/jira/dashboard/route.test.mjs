import { test } from "node:test";
import assert from "node:assert/strict";
import * as view from "../../../../lib/jira/view.ts";
import { loadTs } from "../../../../tests/load-ts.mjs";

// /api/jira/dashboard with doubles: sign-in, configuration, the window
// check, the Jira connection, and which projects reach the dashboard build.
const json = (body, status = 200) => Response.json(body, { status });

function load({ user = { id: "u" }, admin = {}, key = "k", connected = true, tasks = [] } = {}) {
  const builds = [];
  const supabase = {
    from: (table) => ({ select: () => ({ returns: async () => ({ data: table === "scheduled_tasks" ? tasks : null, error: null }) }) }),
  };
  const route = loadTs(new URL("./route.ts", import.meta.url), {
    "@/lib/supabase/route-auth": {
      routeUser: async () => (user ? { user, supabase } : { error: json({ error: "Signed out" }, 401) }),
      json,
    },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/agent/server": { agentEncryptionKey: () => key },
    "@/lib/scheduled/server": {
      loadConnection: async () => ({
        public: { jiraConnected: connected },
        credentials: { jiraSite: "https://acme.atlassian.net", jiraEmail: "me@acme.test", jiraToken: "t", githubToken: "" },
      }),
    },
    "@/lib/jira/dashboard": {
      buildJiraDashboard: async (credentials, options) => {
        builds.push({ credentials, options });
        return { site: credentials.jiraSite, days: options.days, projects: ["SPEC"] };
      },
    },
    "@/lib/jira/view": view,
  });
  return { route, builds };
}

const get = (query = "") => new Request(`http://localhost/api/jira/dashboard${query}`);

test("requires sign-in and server configuration", async () => {
  assert.equal((await load({ user: null }).route.GET(get())).status, 401);
  assert.equal((await load({ admin: null }).route.GET(get())).status, 503);
  assert.equal((await load({ key: null }).route.GET(get())).status, 503);
});

test("accepts only the offered windows", async () => {
  const { route, builds } = load();
  for (const bad of ["?days=3", "?days=abc", "?days=7.5", "?days="]) assert.equal((await route.GET(get(bad))).status, 400);
  assert.equal(builds.length, 0);
  assert.equal((await route.GET(get("?days=30"))).status, 200);
  assert.equal(builds[0].options.days, 30);
});

test("asks to connect Jira when there is no saved connection", async () => {
  const { route, builds } = load({ connected: false });
  const response = await route.GET(get());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "not_connected");
  assert.equal(builds.length, 0);
});

test("builds the dashboard with the projects saved on debriefs", async () => {
  const { route, builds } = load({ tasks: [{ jira_projects: ["SPEC", "PM"] }, { jira_projects: ["OPS"] }, { jira_projects: null }] });
  const response = await route.GET(get());
  assert.equal(response.status, 200);
  assert.deepEqual(builds[0].options, { days: 7, configuredProjects: ["SPEC", "PM", "OPS"] });
  assert.equal((await response.json()).dashboard.site, "https://acme.atlassian.net");
});
