import Link from "next/link";
import { Orbit } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { verifyLinkToken } from "@/lib/slack";
import { linkSlackAccount } from "./actions";

const messages = {
  linked: [
    "Slack is connected",
    "Use “Send to Orbit” on any Slack message and it will land in your Inbox.",
  ],
  expired: [
    "This link has expired",
    "Run “Send to Orbit” in Slack again to get a fresh link.",
  ],
  failed: [
    "Something went wrong",
    "Slack could not be connected. Please try again from Slack.",
  ],
  signin: [
    "Sign in first",
    "Sign in to Orbit in this browser, then open the link from Slack again.",
  ],
} as const;

export default async function SlackLink({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; status?: string }>;
}) {
  const { token, status } = await searchParams;
  const secret = process.env.SLACK_SIGNING_SECRET;
  const identity = token && secret ? verifyLinkToken(token, secret) : null;
  let state: keyof typeof messages | "confirm" =
    status && status in messages
      ? (status as keyof typeof messages)
      : identity
        ? "confirm"
        : "expired";
  let email = "";
  if (state === "confirm") {
    const supabase = authConfig() ? await createClient() : null;
    const user = supabase && (await supabase.auth.getUser()).data.user;
    if (!user) state = "signin";
    else email = user.email || "your account";
  }
  return (
    <main className="auth-page">
      <Link href="/" className="auth-brand">
        <Orbit size={32} strokeWidth={1.4} />
        <span>orbit.</span>
      </Link>
      <div className="auth-layout slack-link-layout">
        <section className="auth-card">
          <div className="auth-card-icon">
            <Orbit size={26} strokeWidth={1.3} />
          </div>
          {state === "confirm" ? (
            <>
              <h2>Connect Slack</h2>
              <p className="auth-subtitle">
                Messages you send to Orbit from the{" "}
                <strong>{identity?.teamName || "Slack"}</strong> workspace will
                go to the Inbox of <strong>{email}</strong>.
              </p>
              <form action={linkSlackAccount} className="auth-form">
                <input type="hidden" name="token" value={token} />
                <button className="primary-button" type="submit">
                  Connect Slack
                </button>
              </form>
            </>
          ) : (
            <>
              <h2>{messages[state][0]}</h2>
              <p className="auth-subtitle">{messages[state][1]}</p>
              <Link
                className="secondary-button"
                href={state === "signin" ? "/login" : "/"}
              >
                {state === "signin" ? "Sign in" : "Open Orbit"}
              </Link>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
