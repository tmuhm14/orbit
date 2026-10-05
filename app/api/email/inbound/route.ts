import { createAdminClient } from "@/lib/supabase/admin";
import {
  emailRecipients,
  inboxTokens,
  noteFromEmail,
  verifyResendWebhook,
  type ReceivedEmail,
} from "@/lib/email";

// Resend calls this for every email sent to the receiving domain. The webhook
// carries metadata only; the body is fetched from Resend's API with our key,
// so a forged event could not inject content even if a signature check failed.
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const apiKey = process.env.RESEND_API_KEY;
  const domain = process.env.RESEND_INBOUND_DOMAIN;
  const admin = createAdminClient();
  if (!secret || !apiKey || !domain || !admin)
    return new Response("Not configured", { status: 503 });

  const raw = await request.text();
  if (
    !verifyResendWebhook(
      raw,
      {
        id: request.headers.get("svix-id"),
        timestamp: request.headers.get("svix-timestamp"),
        signature: request.headers.get("svix-signature"),
      },
      secret,
    )
  )
    return new Response("Invalid signature", { status: 401 });

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  const emailId = event.data?.email_id;
  if (event.type !== "email.received" || !emailId)
    return new Response(null, { status: 200 });

  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
  );
  // A non-2xx response makes Resend retry later.
  if (!response.ok)
    return new Response("Could not fetch email", { status: 502 });
  const email: ReceivedEmail = await response.json();

  const tokens = inboxTokens(emailRecipients(email), domain);
  if (!tokens.length) return new Response(null, { status: 200 });
  const { data: workspaces, error: lookupError } = await admin
    .from("workspaces")
    .select("id,user_id")
    .in("inbox_token", tokens);
  if (lookupError) return new Response("Lookup failed", { status: 500 });

  const { note, sourceRef } = noteFromEmail(email);
  for (const workspace of workspaces) {
    const { error } = await admin.from("notes").upsert(
      {
        id: crypto.randomUUID(),
        user_id: workspace.user_id,
        workspace_id: workspace.id,
        title: note.title,
        content: note.content,
        plain_text: note.plainText,
        bucket: note.bucket,
        tags: note.tags,
        source: note.source,
        source_ref: sourceRef,
        origin: note.origin,
        triage_status: "pending",
        created_at: note.createdAt,
        updated_at: note.updatedAt,
      },
      { onConflict: "user_id,source_ref", ignoreDuplicates: true },
    );
    if (error) return new Response("Could not save", { status: 500 });
  }
  return new Response(null, { status: 200 });
}
