import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { siteUrl } from "@/lib/supabase/config";
import {
  SHORTCUT_CALLBACK_ID,
  escapeSlackText,
  noteFromSlackMessage,
  signLinkToken,
  verifySlackRequest,
  type SlackMessageAction,
} from "@/lib/slack";

// Receives Slack interactivity payloads. Slack expects a 200 within three
// seconds, so the user-facing reply goes to response_url after responding.
export async function POST(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const admin = createAdminClient();
  if (!secret || !admin) return new Response("Not configured", { status: 503 });

  const raw = await request.text();
  if (
    !verifySlackRequest(
      raw,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      secret,
    )
  )
    return new Response("Invalid signature", { status: 401 });

  let action: SlackMessageAction;
  try {
    action = JSON.parse(new URLSearchParams(raw).get("payload") || "");
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (
    action?.type !== "message_action" ||
    action.callback_id !== SHORTCUT_CALLBACK_ID
  )
    return new Response(null, { status: 200 });

  const reply = (text: string) =>
    after(async () => {
      const url = new URL(action.response_url);
      if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com")
        return;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          replace_original: false,
          text,
        }),
      });
    });

  const { data: link, error: linkError } = await admin
    .from("slack_links")
    .select("user_id")
    .eq("slack_team_id", action.team.id)
    .eq("slack_user_id", action.user.id)
    .maybeSingle();
  if (linkError) {
    reply("Orbit couldn't save that message right now. Please try again.");
    return new Response(null, { status: 200 });
  }
  if (!link) {
    const token = signLinkToken(
      {
        teamId: action.team.id,
        userId: action.user.id,
        teamName: action.team.domain,
      },
      secret,
    );
    reply(
      `Connect this Slack account to Orbit first: <${siteUrl()}/slack/link?token=${token}|Connect to Orbit>. The link expires in 15 minutes. Then send the message again.`,
    );
    return new Response(null, { status: 200 });
  }

  const { note, sourceRef } = noteFromSlackMessage(action);
  const { data: inserted, error } = await admin
    .from("notes")
    .upsert(
      {
        id: note.id,
        user_id: link.user_id,
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
    )
    .select("id");
  if (error)
    reply("Orbit couldn't save that message right now. Please try again.");
  else if (!inserted.length)
    reply("That message is already in your Orbit inbox.");
  else reply(`Added to your Orbit inbox: *${escapeSlackText(note.title)}*`);
  return new Response(null, { status: 200 });
}
