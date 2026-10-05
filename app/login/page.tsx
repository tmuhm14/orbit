import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  const configured = !!authConfig();
  if (configured) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect("/");
  }
  const params = await searchParams;
  return (
    <AuthForm
      configured={configured}
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
