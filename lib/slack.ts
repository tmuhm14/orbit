import { createHmac, timingSafeEqual } from "node:crypto";
import { textDoc, type Note, type NoteOrigin } from "./notes.ts";

/** callback_id of the "Send to Orbit" message shortcut in the Slack app. */
export const SHORTCUT_CALLBACK_ID = "send_to_orbit";
const MAX_AGE_SECONDS = 60 * 5;
const LINK_TTL_SECONDS = 60 * 15;

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks Slack's request signature (v0 HMAC-SHA256 over the raw body) and
 * rejects stale timestamps so captured requests cannot be replayed.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackRequest(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const expected =
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");
  return safeEqual(expected, signature);
}

/** Converts Slack mrkdwn entities to readable plain text. */
export function slackTextToPlain(text: string): string {
  return text
    .replace(/<([^<>|]+)\|([^<>]+)>/g, (_, target: string, label: string) =>
      target.startsWith("#")
        ? `#${label}`
        : target.startsWith("@") || target.startsWith("!")
          ? `@${label}`
          : `${label} (${target})`,
    )
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/<#([A-Z0-9]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<([^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export const escapeSlackText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type SlackMessageAction = {
  type: "message_action";
  callback_id: string;
  response_url: string;
  team: { id: string; domain?: string };
  user: { id: string; name?: string; username?: string };
  channel: { id: string; name?: string };
  message: { ts: string; text?: string; user?: string; thread_ts?: string };
};

export function slackPermalink(action: SlackMessageAction) {
  if (!action.team.domain) return undefined;
  const { ts, thread_ts } = action.message;
  const url = new URL(
    `https://${action.team.domain}.slack.com/archives/${action.channel.id}/p${ts.replace(".", "")}`,
  );
  if (thread_ts && thread_ts !== ts) {
    url.searchParams.set("thread_ts", thread_ts);
    url.searchParams.set("cid", action.channel.id);
  }
  return url.toString();
}

/** Builds the inbox note for a message sent with the "Send to Orbit" shortcut. */
export function noteFromSlackMessage(action: SlackMessageAction) {
  const text = slackTextToPlain(action.message.text || "").trim();
  const firstLine = text.split("\n")[0] || "";
  const title =
    firstLine.length > 120
      ? `${firstLine.slice(0, 117).trimEnd()}…`
      : firstLine || "Slack message";
  const permalink = slackPermalink(action);
  const where = action.channel.name ? `#${action.channel.name}` : "Slack";
  const footer = permalink
    ? `Forwarded from ${where}: ${permalink}`
    : `Forwarded from ${where}`;
  const plainText = text ? `${text}\n\n${footer}` : footer;
  const origin: NoteOrigin = {
    kind: "slack",
    teamId: action.team.id,
    channelId: action.channel.id,
    channelName: action.channel.name,
    messageTs: action.message.ts,
    authorId: action.message.user,
    permalink,
  };
  const now = new Date().toISOString();
  const note: Note = {
    id: crypto.randomUUID(),
    title,
    content: textDoc(plainText),
    plainText,
    bucket: "inbox",
    tags: ["slack"],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    source: "slack",
    origin,
  };
  return {
    note,
    sourceRef: `slack:${action.team.id}:${action.channel.id}:${action.message.ts}`,
  };
}

export type SlackIdentity = {
  teamId: string;
  userId: string;
  teamName?: string;
};

// Link tokens prove control of a Slack account: they are only ever shown to
// that user in an ephemeral reply. The key is derived from the signing secret
// with a distinct prefix so it can never collide with request signatures.
function linkSignature(body: string, secret: string) {
  return createHmac("sha256", `orbit-slack-link:${secret}`)
    .update(body)
    .digest("base64url");
}

export function signLinkToken(
  identity: SlackIdentity,
  secret: string,
  now = Date.now(),
) {
  const body = Buffer.from(
    JSON.stringify({
      ...identity,
      exp: Math.floor(now / 1000) + LINK_TTL_SECONDS,
    }),
  ).toString("base64url");
  return `${body}.${linkSignature(body, secret)}`;
}

export function verifyLinkToken(
  token: string,
  secret: string,
  now = Date.now(),
): SlackIdentity | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  if (!safeEqual(linkSignature(body, secret), signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof data.exp !== "number" || data.exp < now / 1000) return null;
    if (typeof data.teamId !== "string" || typeof data.userId !== "string")
      return null;
    return {
      teamId: data.teamId,
      userId: data.userId,
      teamName: typeof data.teamName === "string" ? data.teamName : undefined,
    };
  } catch {
    return null;
  }
}
