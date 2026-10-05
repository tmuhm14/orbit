import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
import { AuthForm } from "@/components/auth-form";
export default async function ResetPassword() {
  if (!authConfig()) redirect("/login");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=link");
  return <AuthForm configured initialMode="reset" />;
}
