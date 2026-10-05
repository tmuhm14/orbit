import { createHmac, timingSafeEqual } from "node:crypto";
import { textDoc, type Note, type NoteOrigin } from "./notes.ts";
export { inboundAddress, inboxTokens } from "./email-address.ts";

const MAX_AGE_SECONDS = 60 * 5;
const MAX_BODY = 50_000;

/**
 * Verifies a Resend webhook. Resend signs with Svix: HMAC-SHA256 over
 * "<svix-id>.<svix-timestamp>.<body>" using the base64 key after "whsec_".
 * The signature header may list several space-separated "v1,<base64>" values.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
  secret: string,
  now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(
    createHmac("sha256", key)
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest("base64"),
  );
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Readable plain text from an email's HTML part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(
      /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && text !== href ? `${text} (${href})` : href;
      },
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, code: string) => {
      if (code[0] === "#")
        return String.fromCodePoint(
          code[1]?.toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10),
        );
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A received email as returned by GET /emails/receiving/{id}. */
export type ReceivedEmail = {
  id: string;
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  received_for?: string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  message_id?: string | null;
  attachments?: { filename?: string }[];
};

export function emailRecipients(email: ReceivedEmail) {
  return [
    ...(email.to ?? []),
    ...(email.cc ?? []),
    ...(email.bcc ?? []),
    ...(email.received_for ?? []),
  ];
}

function emailBody(email: ReceivedEmail) {
  if (email.text?.trim()) return email.text.trim();
  let html = email.html || "";
  const dataUri = html.match(/^data:text\/html[^,]*?(;base64)?,([\s\S]*)$/);
  if (dataUri)
    html = dataUri[1]
      ? Buffer.from(dataUri[2], "base64").toString("utf8")
      : decodeURIComponent(dataUri[2]);
  return htmlToText(html);
}

/** Builds the inbox note for an email sent to a workspace's address. */
export function noteFromEmail(email: ReceivedEmail) {
  let body = emailBody(email).replace(/\r\n/g, "\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n…`;
  const subject = (email.subject || "")
    .replace(/^\s*((fwd?|fw)\s*:\s*)+/i, "")
    .trim();
  const firstLine = body.split("\n").find((line) => line.trim()) || "";
  const title = (subject || firstLine || `Email from ${email.from}`).slice(
    0,
    200,
  );
  const attachments = (email.attachments ?? [])
    .map((a) => a.filename)
    .filter(Boolean);
  const footer = [
    `Emailed from ${email.from}`,
    attachments.length
      ? `Attachments (not imported): ${attachments.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const plainText = body ? `${body}\n\n${footer}` : footer;
  const origin: NoteOrigin = {
    kind: "email",
    from: email.from,
    subject: email.subject || undefined,
    messageId: email.message_id || undefined,
  };
  const now = new Date().toISOString();
  const note: Note = {
    id: crypto.randomUUID(),
    title,
    content: textDoc(plainText),
    plainText,
    bucket: "inbox",
    tags: ["email"],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    source: "email",
    origin,
    workspaceId: "",
  };
  return { note, sourceRef: `email:${email.message_id || email.id}` };
}
