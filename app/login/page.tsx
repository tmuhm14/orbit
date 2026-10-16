import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { safeNext } from "@/lib/oauth/validation";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; updated?: string; next?: string | string[] }>;
}) {
  const configured = !!authConfig();
  const params = await searchParams;
  // Where to go after signing in, for example back to an app's consent
  // screen (/oauth/authorize). Relative same-origin paths only.
  const next = safeNext(params.next) ?? undefined;
  if (configured) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect(next ?? "/");
  }
  return (
    <AuthForm
      configured={configured}
      next={next}
      emailEnabled={process.env.AUTH_EMAIL_ENABLED === "true"}
      initialMessage={
        params.updated
          ? "Password updated. Sign in with your new password."
          : undefined
      }
      initialError={
        params.error === "link"
          ? "That link has expired or was opened in another browser. Please request a new link."
          : undefined
      }
    />
  );
}
