// Settings sub-pages (/settings/*) and the small view helpers they share.
// Pure: no React, no Next, so the routes, labels and dirty checks are tested
// in node (settings-sections.test.mjs).

export const SETTINGS_SECTIONS = [
  { id: "account", path: "account", label: "Account", description: "Your sign-in, password and session." },
  { id: "spaces", path: "spaces", label: "Spaces", description: "Create, rename and recolor spaces, and choose which one opens first." },
  { id: "capture", path: "capture", label: "Capture", description: "Where Slack and email send new notes." },
  { id: "model", path: "model", label: "Model & agent", description: "The model provider and key the organizing agent uses, and where it may work." },
  { id: "integrations", path: "integrations", label: "Integrations", description: "Jira and GitHub, the sources for scheduled reports." },
  { id: "agents", path: "agents", label: "Agents & API keys", description: "Keys for external agents and bots, and what they did." },
  { id: "setup", path: "agents/setup", label: "Setup guide", description: "How to set up the organizing agent, delegation and external bots, step by step." },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "account";

export const isSettingsSection = (value: unknown): value is SettingsSection =>
  SETTINGS_SECTIONS.some((s) => s.id === value);

export function settingsSection(id: SettingsSection) {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
}

/** Anchors in the setup guide; each Settings section links to its part. */
export const GUIDE_ANCHORS = {
  organizingAgent: "organizing-agent",
  delegation: "delegation",
  externalBots: "external-bots",
  createKey: "create-key",
  callApi: "call-the-api",
  mcp: "mcp",
  revoke: "revoke-and-rotate",
  accessLog: "access-log",
  security: "security",
  troubleshooting: "troubleshooting",
} as const;
export type GuideAnchor = (typeof GUIDE_ANCHORS)[keyof typeof GUIDE_ANCHORS];

/** `/settings/<section>`, with an optional `#anchor`. */
export function settingsHref(section: SettingsSection = DEFAULT_SETTINGS_SECTION, anchor?: GuideAnchor | string) {
  const path = `/settings/${settingsSection(section).path}`;
  return anchor ? `${path}#${anchor}` : path;
}

/** A link into the setup guide. */
export const guideHref = (anchor?: GuideAnchor) => settingsHref("setup", anchor);

/**
 * The section for the path segments after `/settings`. `/settings` itself is
 * Account (the page redirects there); unknown subpaths return null.
 */
export function parseSettingsSection(segments: string[]): SettingsSection | null {
  const path = segments.join("/");
  if (!path) return DEFAULT_SETTINGS_SECTION;
  return SETTINGS_SECTIONS.find((s) => s.path === path)?.id ?? null;
}

/** True when any field differs from where the form started. */
export function isDirty<T extends Record<string, unknown>>(initial: T, current: T) {
  return (Object.keys({ ...initial, ...current }) as (keyof T)[]).some((key) => {
    const a = initial[key];
    const b = current[key];
    if (a instanceof Set && b instanceof Set) return a.size !== b.size || [...a].some((v) => !b.has(v));
    return a !== b;
  });
}

/** "•••• 1a2b" for a saved secret's last characters; never more than the hint. */
export const maskedHint = (hint: string | null | undefined) => (hint ? `•••• ${hint.slice(-4)}` : "Not saved");

/** The documented `/api/v1` errors and what to do about each. */
export const TROUBLESHOOTING = [
  {
    code: "invalid_credentials", status: 401,
    meaning: "The key is missing, mistyped, cut short or unknown.",
    fix: "Check the Authorization header is exactly “Bearer ” followed by the whole key. If the key is lost, create a new one; Orbit can’t show an old key again.",
  },
  {
    code: "client_revoked", status: 401,
    meaning: "The key was revoked in Settings.",
    fix: "Create a new key in Settings → Agents & API keys and replace the old one in the bot’s secret store.",
  },
  {
    code: "capability_denied", status: 403,
    meaning: "The key has no Read or Capture grant in that space (or the space doesn’t exist).",
    fix: "Open Settings → Agents & API keys, choose Edit access on the key and tick Read or Capture for the space. It applies on the next request.",
  },
  {
    code: "agent_disabled", status: 403,
    meaning: "The space’s agent switch is off, which blocks every key there.",
    fix: "Turn on “Allow the agent” for the space in Settings → Model & agent.",
  },
  {
    code: "not_configured", status: 503,
    meaning: "The Orbit server is missing a setting, such as ORBIT_API_KEY_PEPPER.",
    fix: "Ask whoever runs your Orbit server to finish its configuration. Nothing on your side will fix this.",
  },
] as const;

/** Placeholders only: the guide never shows a real key. */
export const PLACEHOLDER_KEY = "orbit_sk_your_key_here";

export function curlExample(origin: string) {
  return [
    `export ORBIT_URL="${origin}"`,
    `export ORBIT_API_KEY="${PLACEHOLDER_KEY}"   # from your secret store`,
    "",
    "# List the spaces this key can use",
    `curl "$ORBIT_URL/api/v1/workspaces" \\`,
    `  -H "Authorization: Bearer $ORBIT_API_KEY"`,
    "",
    "# Capture a note into a space's Inbox (needs Capture)",
    `curl -X POST "$ORBIT_URL/api/v1/notes" \\`,
    `  -H "Authorization: Bearer $ORBIT_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"workspaceId":"<id from the list>","title":"Follow up","text":"Call the vendor"}'`,
  ].join("\n");
}

export function mcpConfigExample(origin: string) {
  return JSON.stringify({
    mcpServers: {
      orbit: {
        command: "node",
        args: ["/absolute/path/to/orbit/scripts/orbit-mcp.mjs"],
        env: { ORBIT_URL: origin, ORBIT_API_KEY: PLACEHOLDER_KEY },
      },
    },
  }, null, 2);
}

/** The origin shown in examples when the page's own origin isn't known yet. */
export const EXAMPLE_ORIGIN = "https://your-orbit.example.com";
